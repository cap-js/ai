import { setTimeout as delay } from 'node:timers/promises';
import { TransformStream } from 'node:stream/web';

import { normalizeHubUrl } from './model-utils.js';

const MODEL_REPOSITORY = 'model';
const HUB_REQUEST_TIMEOUT_MS = 30_000;
const HUB_REQUEST_RETRIES = 2;
const HUB_RETRY_DELAY_MS = 250;
const HUB_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const MODEL_INFO_FIELDS = [
  'cardData',
  'config',
  'filePaths',
  'library_name',
  'sha',
  'tags',
  'transformersInfo'
];

function createHuggingFaceClient(options = {}) {
  const { fetchImpl = globalThis.fetch, bindings } = options;
  const hubUrl = options.hubUrl === undefined ? undefined : normalizeHubUrl(options.hubUrl);
  const requestOptions = {
    timeoutMs: options.requestTimeoutMs ?? HUB_REQUEST_TIMEOUT_MS,
    retries: options.requestRetries ?? HUB_REQUEST_RETRIES,
    retryDelayMs: options.requestRetryMs ?? HUB_RETRY_DELAY_MS,
    maxResponseBytes: positiveByteLimit(
      options.maxResponseBytes ?? HUB_RESPONSE_MAX_BYTES,
      'maxResponseBytes'
    )
  };
  const loadedBindings = resolveBindings(bindings);

  return {
    async getModelInfo(repository) {
      const { modelInfo } = await loadedBindings;
      return runHubOperation(
        `reading model metadata for '${repository}'`,
        (fetch) =>
          modelInfo({
            name: repository,
            additionalFields: MODEL_INFO_FIELDS,
            fetch,
            hubUrl
          }),
        fetchImpl,
        requestOptions
      );
    },

    async getFiles(repository, revision) {
      const { listFiles } = await loadedBindings;
      return runHubOperation(
        `listing files for '${repository}'`,
        async (fetch) => {
          const files = [];
          for await (const file of listFiles({
            repo: { type: MODEL_REPOSITORY, name: repository },
            revision,
            recursive: true,
            fetch,
            hubUrl
          })) {
            if (file.type === 'file') files.push(file);
          }
          return files;
        },
        fetchImpl,
        requestOptions
      );
    },

    async getFile(repository, revision, remotePath) {
      const { downloadFile } = await loadedBindings;
      return runHubOperation(
        `downloading '${repository}/${remotePath}'`,
        async (fetch) => {
          const file = await downloadFile({
            repo: { type: MODEL_REPOSITORY, name: repository },
            path: remotePath,
            revision,
            xet: false,
            fetch,
            hubUrl
          });
          if (!file) {
            throw new Error(
              `Hugging Face model '${repository}' does not contain '${remotePath}' at ${revision}`
            );
          }
          return readBlob(file, requestOptions.maxResponseBytes, repository, remotePath);
        },
        fetchImpl,
        requestOptions
      );
    }
  };
}

async function runHubOperation(description, operation, fetchImpl, options) {
  const { timeoutMs, retries, retryDelayMs, maxResponseBytes } = options;
  return attemptOperation(0);

  async function attemptOperation(attempt) {
    const controller = new AbortController();
    let timeout;
    const timedOperation = Promise.race([
      operation(createOperationFetch(fetchImpl, controller.signal, maxResponseBytes)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new HubTimeoutError(description, timeoutMs));
          controller.abort();
        }, timeoutMs);
      })
    ]);

    try {
      return await timedOperation;
    } catch (error) {
      if (!isRetryable(error) || attempt >= retries) throw error;
      await delay(retryDelayMs * 2 ** attempt);
      return attemptOperation(attempt + 1);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function createOperationFetch(fetchImpl, signal, maxResponseBytes) {
  return async (input, init = {}) => {
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal
      });
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        throw new RetryableHubResponseError(response.status, input);
      }
      return await limitResponseSize(response, maxResponseBytes, input);
    } catch (error) {
      if (error instanceof RetryableHubResponseError || error instanceof HubResponseTooLargeError) {
        throw error;
      }
      throw new HubTransportError(input, { cause: error });
    }
  };
}

async function limitResponseSize(response, maxBytes, input) {
  const declaredSize = declaredResponseSize(response);
  if (declaredSize !== undefined && declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new HubResponseTooLargeError(input, maxBytes);
  }
  if (!response.body) return response;

  let received = 0;
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          throw new HubResponseTooLargeError(input, maxBytes);
        }
        controller.enqueue(chunk);
      }
    })
  );
  const limited = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
  Object.defineProperties(limited, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url }
  });
  return limited;
}

function declaredResponseSize(response) {
  const contentLengthHeader = response.headers?.get?.('content-length');
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  const contentRange = response.headers?.get?.('content-range');
  const match = typeof contentRange === 'string' && /^bytes\s+\d+-\d+\/(\d+)$/iu.exec(contentRange);
  const rangeTotal = match ? Number(match[1]) : undefined;
  const candidates = [contentLength, rangeTotal].filter(
    (value) => Number.isSafeInteger(value) && value >= 0
  );
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

async function readBlob(file, maxBytes, repository, remotePath) {
  const description = `${repository}/${remotePath}`;
  if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.stream !== 'function') {
    throw new Error(`Hugging Face returned an invalid file response for ${description}`);
  }
  if (file.size > maxBytes) {
    throw new HubResponseTooLargeError(description, maxBytes);
  }

  const chunks = [];
  let received = 0;
  for await (const value of file.stream()) {
    const chunk = Buffer.from(value);
    received += chunk.byteLength;
    if (received > maxBytes) throw new HubResponseTooLargeError(description, maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

function positiveByteLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isRetryable(error) {
  return (
    error instanceof HubTimeoutError ||
    error instanceof HubTransportError ||
    error instanceof RetryableHubResponseError
  );
}

class HubTimeoutError extends Error {
  constructor(description, timeoutMs) {
    super(`Timed out after ${timeoutMs} ms while ${description}`);
    this.name = 'HubTimeoutError';
  }
}

class HubTransportError extends Error {
  constructor(input, options) {
    super(`Hugging Face request failed for ${String(input)}`, options);
    this.name = 'HubTransportError';
  }
}

class RetryableHubResponseError extends Error {
  constructor(status, input) {
    super(`Hugging Face request failed with status ${status} for ${String(input)}`);
    this.name = 'RetryableHubResponseError';
    this.status = status;
  }
}

class HubResponseTooLargeError extends Error {
  constructor(input, maxBytes) {
    super(`Refusing Hugging Face response for ${String(input)}: exceeds ${maxBytes} bytes`);
    this.name = 'HubResponseTooLargeError';
  }
}

async function resolveBindings(bindings) {
  if (
    typeof bindings?.modelInfo === 'function' &&
    typeof bindings?.listFiles === 'function' &&
    typeof bindings?.downloadFile === 'function'
  ) {
    return bindings;
  }
  return { ...(await loadHuggingFaceHub()), ...bindings };
}

async function loadHuggingFaceHub(importModule = (specifier) => import(specifier)) {
  try {
    return await importModule('@huggingface/hub');
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      /Cannot find package ['"]@huggingface\/hub['"]/.test(error.message)
    ) {
      throw new Error(
        "Automatic Hugging Face model discovery requires @huggingface/hub. Install it with 'npm add -D @huggingface/hub'.",
        { cause: error }
      );
    }
    throw error;
  }
}

export {
  HUB_REQUEST_RETRIES,
  HUB_REQUEST_TIMEOUT_MS,
  HUB_RESPONSE_MAX_BYTES,
  createHuggingFaceClient,
  loadHuggingFaceHub
};
