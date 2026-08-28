import { setTimeout as delay } from 'node:timers/promises';

const MODEL_REPOSITORY = 'model';
const HUB_REQUEST_TIMEOUT_MS = 30_000;
const HUB_REQUEST_RETRIES = 2;
const HUB_RETRY_DELAY_MS = 250;
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
  const { fetchImpl = globalThis.fetch, hubUrl, bindings } = options;
  const requestOptions = {
    timeoutMs: options.requestTimeoutMs ?? HUB_REQUEST_TIMEOUT_MS,
    retries: options.requestRetries ?? HUB_REQUEST_RETRIES,
    retryDelayMs: options.requestRetryMs ?? HUB_RETRY_DELAY_MS
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
          return Buffer.from(await file.arrayBuffer());
        },
        fetchImpl,
        requestOptions
      );
    }
  };
}

async function runHubOperation(description, operation, fetchImpl, options) {
  const { timeoutMs, retries, retryDelayMs } = options;
  return attemptOperation(0);

  async function attemptOperation(attempt) {
    const controller = new AbortController();
    let timeout;
    const timedOperation = Promise.race([
      operation(createOperationFetch(fetchImpl, controller.signal)),
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

function createOperationFetch(fetchImpl, signal) {
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
      return response;
    } catch (error) {
      if (error instanceof RetryableHubResponseError) throw error;
      throw new HubTransportError(input, { cause: error });
    }
  };
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

export { HUB_REQUEST_RETRIES, HUB_REQUEST_TIMEOUT_MS, createHuggingFaceClient, loadHuggingFaceHub };
