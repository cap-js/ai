import { installModel } from './model-install.js';
import {
  getModelDirectory,
  getModelRoot,
  loadModelAndTokenizer,
  readModelLock,
  verifyModelDirectory
} from './model-utils.js';

const STANDARD_INPUT_NAMES = new Set(['input_ids', 'attention_mask', 'token_type_ids']);

async function createEmbeddingRuntime(configuration, options = {}) {
  const { model, modelDir } = await resolveEmbeddingModel(configuration, options);
  return createEmbeddingRuntimeFromModel(modelDir, model);
}

async function createEmbeddingRuntimeFromModel(modelDir, model) {
  const { session, tokenizer } = await loadModelAndTokenizer(modelDir, model);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await session.dispose();
  };

  try {
    const tokenizerState = createTokenizerState(tokenizer, model.maxLength);

    validateSession(session, model);

    const runtime = {
      dimensions: model.dimensions,
      embedding(text) {
        const input = tokenizeToWindow(String(text), tokenizer, tokenizerState);
        return processEmbedding(input, session, model);
      },
      vectorEmbedding(text) {
        if (!text) return JSON.stringify(new Array(model.dimensions).fill(0));
        return JSON.stringify(Array.from(this.embedding(text)));
      },
      dispose
    };

    const probe = runtime.embedding('embedding model startup probe');
    if (probe.length !== model.dimensions) {
      throw new Error(
        `Embedding model produced ${probe.length} dimensions; configured ${model.dimensions}`
      );
    }
    return runtime;
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

async function validateEmbeddingModel(modelDir, model) {
  const runtime = await createEmbeddingRuntimeFromModel(modelDir, model);
  await runtime.dispose();
}

async function resolveEmbeddingModel(configuration, options = {}) {
  const {
    root = process.cwd(),
    warn = (message) => console.warn(message),
    fetchImpl,
    discover,
    validate
  } = options;
  const { model: modelName, directory } = normalizeEmbeddingConfiguration(configuration);
  const modelRoot = getModelRoot(directory, root, options.home);
  const modelDir = getModelDirectory(modelRoot, modelName);
  const installOptions = {
    root,
    directory: modelRoot,
    home: options.home,
    fetchImpl,
    discover,
    validate: validate ?? validateEmbeddingModel,
    timeoutMs: options.provisionTimeoutMs,
    retryMs: options.provisionRetryMs
  };

  let model;
  try {
    model = await readModelLock(modelDir);
  } catch (error) {
    if (directory !== undefined || !/Embedding model lock not found/.test(error.message)) {
      const recovery = /Embedding model lock not found/.test(error.message)
        ? modelInstallHint(modelName, directory)
        : `Remove or replace the invalid lock explicitly, then ${lowercaseFirst(
            modelInstallHint(modelName, directory)
          )}`;
      throw new Error(`${error.message}. ${recovery}`, { cause: error });
    }
    return installModelOnDemand(modelName, modelDir, installOptions, warn);
  }

  if (model.repository !== modelName) {
    throw new Error(
      `Embedding model directory ${modelDir} contains ${model.repository}, not ${modelName}. Choose another directory or provision the configured model there.`
    );
  }
  try {
    await verifyModelDirectory(modelDir, model);
  } catch (error) {
    if (directory !== undefined) {
      throw new Error(`${error.message}. ${modelInstallHint(modelName, directory)}`, {
        cause: error
      });
    }
    return installModelOnDemand(modelName, modelDir, installOptions, warn);
  }
  return { model, modelDir };
}

async function installModelOnDemand(modelName, modelDir, options, warn) {
  warn(
    `Embedding model '${modelName}' is not available in '${modelDir}'. Downloading it now; application startup may be delayed. ${modelInstallHint(modelName)}`
  );
  try {
    return await installModel(modelName, options);
  } catch (error) {
    throw new Error(
      `Failed to install embedding model '${modelName}': ${error.message}. ${modelInstallHint(modelName)}`,
      { cause: error }
    );
  }
}

function normalizeEmbeddingConfiguration(configuration) {
  if (configuration == null) {
    throw new Error('cds.env.requires.db.embedding.model must be a non-empty string');
  }
  if (typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new TypeError('embedding must be an object');
  }
  if (typeof configuration.model !== 'string' || !configuration.model.trim()) {
    throw new Error('cds.env.requires.db.embedding.model must be a non-empty string');
  }
  if (
    configuration.directory !== undefined &&
    (typeof configuration.directory !== 'string' || !configuration.directory.trim())
  ) {
    throw new Error('embedding.directory must be a non-empty string');
  }
  return { model: configuration.model, directory: configuration.directory };
}

function modelInstallHint(repository, directory) {
  const directoryArgument = directory === undefined ? '' : ` --directory ${directory}`;
  return `Run 'npx @cap-js/ai install-model ${repository}${directoryArgument}'.`;
}

function lowercaseFirst(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

function createTokenizerState(tokenizer, maxLength) {
  const probeText = 'embedding tokenizer boundary probe';
  const content = normalizeEncoding(
    tokenizer.encode(probeText, {
      add_special_tokens: false,
      return_token_type_ids: true
    })
  );
  const wrapped = normalizeEncoding(
    tokenizer.encode(probeText, {
      add_special_tokens: true,
      return_token_type_ids: true
    })
  );

  const contentOffset = findSubarray(wrapped.ids, content.ids);
  if (content.ids.length === 0 || contentOffset < 0) {
    throw new Error('Tokenizer special-token layout is incompatible with windowed encoding');
  }

  const prefix = sliceEncoding(wrapped, 0, contentOffset);
  const suffix = sliceEncoding(wrapped, contentOffset + content.ids.length);
  if (prefix.ids.length + suffix.ids.length >= maxLength) {
    throw new Error('embedding.maxLength leaves no room for tokenizer content');
  }
  return { maxLength, prefix, suffix };
}

function tokenizeToWindow(text, tokenizer, { maxLength, prefix, suffix }) {
  // tokenizers.js intentionally ignores tokenizer.json truncation. Encode the complete
  // content without special tokens, truncate it, then add the tokenizer-derived boundaries.
  const encoded = normalizeEncoding(
    tokenizer.encode(text, {
      add_special_tokens: false,
      return_token_type_ids: true
    })
  );
  const maxContentLength = maxLength - prefix.ids.length - suffix.ids.length;
  return concatenateEncodings(prefix, sliceEncoding(encoded, 0, maxContentLength), suffix);
}

function normalizeEncoding(encoding) {
  if (!encoding || typeof encoding !== 'object') {
    throw new Error('Tokenizer did not return an encoding');
  }
  validateTokenIds(encoding.ids);
  const attentionMask = encoding.attention_mask ?? new Array(encoding.ids.length).fill(1);
  const tokenTypeIds = encoding.token_type_ids ?? new Array(encoding.ids.length).fill(0);
  validateAttentionMask(attentionMask);
  validateTokenIds(tokenTypeIds);
  if (attentionMask.length !== encoding.ids.length || tokenTypeIds.length !== encoding.ids.length) {
    throw new Error('Tokenizer metadata length does not match its token IDs');
  }
  return { ids: encoding.ids, attention_mask: attentionMask, token_type_ids: tokenTypeIds };
}

function sliceEncoding(encoding, start, end) {
  return Object.fromEntries(
    Object.entries(encoding).map(([name, values]) => [name, values.slice(start, end)])
  );
}

function concatenateEncodings(...encodings) {
  return {
    ids: encodings.flatMap(({ ids }) => ids),
    attention_mask: encodings.flatMap(({ attention_mask: attentionMask }) => attentionMask),
    token_type_ids: encodings.flatMap(({ token_type_ids: tokenTypeIds }) => tokenTypeIds)
  };
}

function findSubarray(values, expected) {
  outer: for (let offset = 0; offset <= values.length - expected.length; offset++) {
    for (let index = 0; index < expected.length; index++) {
      if (values[offset + index] !== expected[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function validateSession(session, model) {
  const inputNames = session.inputNames;
  const outputNames = session.outputNames;
  if (!Array.isArray(inputNames) || !inputNames.includes('input_ids')) {
    throw new Error("Embedding model must expose the standard int64 input 'input_ids'");
  }
  const unsupportedInputs = inputNames.filter((name) => !STANDARD_INPUT_NAMES.has(name));
  if (unsupportedInputs.length > 0) {
    throw new Error(`Embedding model has unsupported inputs: ${unsupportedInputs.join(', ')}`);
  }
  if (!Array.isArray(outputNames) || !outputNames.includes(model.output.name)) {
    throw new Error(
      `Embedding model output '${model.output.name}' not found. Available outputs: ${outputNames?.join(', ') || 'none'}`
    );
  }
}

function processEmbedding(input, session, model) {
  const results = session.run(createFeeds(input));
  const output = results[model.output.name];
  if (!output) {
    throw new Error(
      `Embedding model output '${model.output.name}' not found. Available outputs: ${Object.keys(results).join(', ')}`
    );
  }
  const embedding = poolOutput(output, model.output.pooling);
  if (embedding.length !== model.dimensions) {
    throw new Error(
      `Embedding model produced ${embedding.length} dimensions; configured ${model.dimensions}`
    );
  }
  return model.output.normalize ? normalizeEmbedding(embedding) : embedding;
}

function createFeeds(encoding) {
  const {
    ids,
    attention_mask: attentionMask,
    token_type_ids: tokenTypeIds
  } = normalizeEncoding(encoding);
  const dimensions = [1, ids.length];
  const values = {
    input_ids: new BigInt64Array(ids.map((id) => BigInt(id))),
    attention_mask: new BigInt64Array(attentionMask.map((value) => BigInt(value))),
    token_type_ids: new BigInt64Array(tokenTypeIds.map((value) => BigInt(value)))
  };
  return Object.fromEntries(
    Object.entries(values).map(([name, data]) => [name, { type: 'int64', data, dims: dimensions }])
  );
}

function poolOutput(output, pooling) {
  const { data, dims, type } = output;
  if (!data || !Array.isArray(dims)) throw new Error('Embedding model returned an invalid tensor');
  if (type !== 'float32' && type !== 'float64') {
    throw new Error(`Embedding model output must be float32 or float64, received '${type}'`);
  }

  if (pooling === 'none') {
    if (dims.length === 1) return Float32Array.from(data);
    if (dims.length === 2 && dims[0] === 1) return Float32Array.from(data);
    throw new Error("Pooling 'none' requires an output shaped [dimensions] or [1, dimensions]");
  }

  if (dims.length !== 3 || dims[0] !== 1 || data.length !== dims[1] * dims[2]) {
    throw new Error(`Pooling '${pooling}' requires an output shaped [1, sequence, dimensions]`);
  }
  const [, sequenceLength, dimensions] = dims;
  if (sequenceLength < 1) throw new Error('Embedding model returned an empty sequence');
  if (pooling === 'cls') return Float32Array.from(data.slice(0, dimensions));

  const embedding = new Float32Array(dimensions);
  for (let token = 0; token < sequenceLength; token++) {
    for (let dimension = 0; dimension < dimensions; dimension++) {
      embedding[dimension] += data[token * dimensions + dimension];
    }
  }
  for (let dimension = 0; dimension < dimensions; dimension++) {
    embedding[dimension] /= sequenceLength;
  }
  return embedding;
}

function normalizeEmbedding(embedding) {
  let squaredNorm = 0;
  for (const value of embedding) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0) return embedding;
  for (let index = 0; index < embedding.length; index++) embedding[index] /= norm;
  return embedding;
}

function validateTokenIds(ids) {
  if (!Array.isArray(ids)) throw new Error('Tokenizer did not return an ID array');
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error(`Invalid token ID detected: ${id} (type: ${typeof id})`);
    }
  }
  return ids;
}

function validateAttentionMask(mask) {
  if (!Array.isArray(mask) || mask.some((value) => value !== 0 && value !== 1)) {
    throw new Error('Tokenizer attention mask must contain only zeros and ones');
  }
  return mask;
}

let sessionRuntime;
let sessionInitialization;

async function createSession(configuration, options) {
  sessionInitialization ??= createEmbeddingRuntime(configuration, options)
    .then((runtime) => (sessionRuntime = runtime))
    .catch((error) => {
      sessionInitialization = undefined;
      throw error;
    });
  return sessionInitialization;
}

function embedding(text) {
  if (!sessionRuntime) {
    throw new Error(
      'Embedding session not initialized. Call createSession() before using embedding().'
    );
  }
  const chunk = { content: text };
  return Object.defineProperty(chunk, 'embedding', {
    value: sessionRuntime.embedding(text),
    writable: true,
    configurable: true,
    enumerable: false
  });
}

export {
  createSession,
  createEmbeddingRuntime,
  createEmbeddingRuntimeFromModel,
  createFeeds,
  createTokenizerState,
  embedding,
  poolOutput,
  resolveEmbeddingModel,
  tokenizeToWindow,
  validateEmbeddingModel
};

export default embedding;
