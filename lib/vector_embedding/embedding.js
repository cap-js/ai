import os from 'os';
import path from 'path';
import { Tensor } from './InferenceSession.js';
import {
  downloadModelIfNeeded,
  getModelCacheDir,
  loadModelAndTokenizer,
  validateModelDescriptor
} from './model-utils.js';

const STANDARD_INPUT_NAMES = new Set(['input_ids', 'attention_mask', 'token_type_ids']);

const DEFAULT_MODEL = Object.freeze({
  repository: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dimensions: 384,
  maxLength: 128,
  files: Object.freeze([
    Object.freeze({
      role: 'model',
      name: 'model.onnx',
      path: 'onnx/model.onnx',
      size: 90387606,
      sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e'
    }),
    Object.freeze({
      role: 'tokenizer',
      name: 'tokenizer.json',
      path: 'tokenizer.json',
      size: 711661,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
    }),
    Object.freeze({
      role: 'tokenizerConfig',
      name: 'tokenizer_config.json',
      path: 'tokenizer_config.json',
      size: 366,
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
    })
  ]),
  output: Object.freeze({
    name: 'last_hidden_state',
    pooling: 'mean',
    normalize: true
  })
});

async function createEmbeddingRuntime(model = DEFAULT_MODEL) {
  validateModelDescriptor(model);
  const modelDir = getModelCacheDir(getModelCacheRoot(), model);
  await downloadModelIfNeeded(modelDir, model);
  const { session, tokenizer } = await loadModelAndTokenizer(modelDir, model);
  const tokenizerState = createTokenizerState(tokenizer, model.maxLength);

  validateSession(session, model);

  const runtime = {
    dimensions: model.dimensions,
    embedding(text) {
      const chunks = tokenizeWithChunks(String(text), tokenizer, tokenizerState);
      return processChunkedEmbeddings(chunks, session, model);
    },
    vectorEmbedding(text) {
      if (!text) return JSON.stringify(new Array(model.dimensions).fill(0));
      return JSON.stringify(Array.from(this.embedding(text)));
    }
  };

  const probe = runtime.embedding('embedding model startup probe');
  if (probe.length !== model.dimensions) {
    throw new Error(
      `Embedding model produced ${probe.length} dimensions; configured ${model.dimensions}`
    );
  }
  return runtime;
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
    throw new Error('Tokenizer special-token layout is incompatible with chunked encoding');
  }

  const prefix = sliceEncoding(wrapped, 0, contentOffset);
  const suffix = sliceEncoding(wrapped, contentOffset + content.ids.length);
  if (prefix.ids.length + suffix.ids.length >= maxLength) {
    throw new Error('embedding.maxLength leaves no room for tokenizer content');
  }
  return { maxLength, prefix, suffix };
}

function tokenizeWithChunks(text, tokenizer, { maxLength, prefix, suffix }) {
  // tokenizers.js intentionally ignores tokenizer.json truncation. Encode the complete
  // content without special tokens, then add the tokenizer-derived boundaries per chunk.
  const encoded = normalizeEncoding(
    tokenizer.encode(text, {
      add_special_tokens: false,
      return_token_type_ids: true
    })
  );
  const maxContentLength = maxLength - prefix.ids.length - suffix.ids.length;
  const chunks = [];

  for (let offset = 0; offset < encoded.ids.length; offset += maxContentLength) {
    chunks.push(
      concatenateEncodings(
        prefix,
        sliceEncoding(encoded, offset, offset + maxContentLength),
        suffix
      )
    );
  }
  if (chunks.length === 0) chunks.push(concatenateEncodings(prefix, suffix));
  return chunks;
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

function processChunkedEmbeddings(chunks, session, model) {
  const embeddings = chunks.map((chunk) => {
    const results = session.run(createFeeds(chunk, session.inputNames));
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
    return embedding;
  });

  const combined = new Float32Array(model.dimensions);
  for (const embedding of embeddings) {
    for (let index = 0; index < combined.length; index++) combined[index] += embedding[index];
  }
  if (embeddings.length > 1) {
    for (let index = 0; index < combined.length; index++) combined[index] /= embeddings.length;
  }
  return model.output.normalize ? normalizeEmbedding(combined) : combined;
}

function createFeeds(encoding, inputNames) {
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
    inputNames.map((name) => [name, new Tensor('int64', values[name], dimensions)])
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

function getDataDir(appName = 'semantic-search') {
  const home = os.homedir();
  const directory =
    os.platform() === 'win32'
      ? process.env.LOCALAPPDATA || process.env.APPDATA || path.join(home, 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

  return path.join(directory, appName);
}

function getModelCacheRoot() {
  return process.env.CDS_AI_MODEL_CACHE || path.join(getDataDir(), 'models');
}

let defaultRuntime;
let defaultInitialization;

async function createSession() {
  defaultInitialization ??= createEmbeddingRuntime()
    .then((runtime) => (defaultRuntime = runtime))
    .catch((error) => {
      defaultInitialization = undefined;
      throw error;
    });
  return defaultInitialization;
}

function embedding(text) {
  if (!defaultRuntime) {
    throw new Error(
      'Embedding session not initialized. Call createSession() before using embedding().'
    );
  }
  const chunk = { content: text };
  return Object.defineProperty(chunk, 'embedding', {
    value: defaultRuntime.embedding(text),
    writable: true,
    configurable: true,
    enumerable: false
  });
}

export {
  DEFAULT_MODEL,
  createSession,
  createEmbeddingRuntime,
  createFeeds,
  createTokenizerState,
  embedding,
  poolOutput,
  tokenizeWithChunks
};

export default embedding;
