import os from 'os';
import path from 'path';
import { Tensor } from './InferenceSession.js';
import {
  downloadModelIfNeeded,
  loadModelAndTokenizer,
  preTokenize,
  wordPieceTokenize,
  validateTokenIds
} from './model-utils.js';

const MODEL = {
  repository: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  files: [
    {
      name: 'model.onnx',
      path: 'onnx/model.onnx',
      size: 90387606,
      sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e'
    },
    {
      name: 'tokenizer.json',
      path: 'tokenizer.json',
      size: 711661,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
    }
  ]
};

/**
 * Main tokenization function that combines all steps
 */
function wordPieceTokenizer(text, tokenizer) {
  const unkToken = '[UNK]';
  const clsToken = '[CLS]';
  const sepToken = '[SEP]';
  const { vocab, maxLength, normalizer } = tokenizer;

  const clsId = vocab.get(clsToken) ?? 101;
  const sepId = vocab.get(sepToken) ?? 102;
  const unkId = vocab.get(unkToken) ?? 100;

  if (typeof clsId !== 'number' || typeof sepId !== 'number' || typeof unkId !== 'number') {
    throw new Error('Special tokens must have numeric IDs');
  }

  const preTokens = preTokenize(text, normalizer);

  const tokens = [clsToken];
  const ids = [clsId];

  for (const preToken of preTokens) {
    const wordPieceTokens = wordPieceTokenize(preToken, vocab, unkToken);

    for (const wpToken of wordPieceTokens) {
      const tokenId = vocab.get(wpToken) ?? unkId;
      tokens.push(wpToken);
      ids.push(tokenId);
    }
  }

  tokens.push(sepToken);
  ids.push(sepId);

  if (tokens.length <= maxLength) return [{ tokens, ids }];

  // Keep each chunk within the limit embedded in the pinned tokenizer.
  const maxContentLength = maxLength - 2;
  const chunks = [];
  const contentTokens = tokens.slice(1, -1);
  const contentIds = ids.slice(1, -1);

  for (let i = 0; i < contentTokens.length; i += maxContentLength) {
    const chunkTokens = [clsToken, ...contentTokens.slice(i, i + maxContentLength), sepToken];
    const chunkIds = [clsId, ...contentIds.slice(i, i + maxContentLength), sepId];

    chunks.push({
      tokens: chunkTokens,
      ids: chunkIds
    });
  }

  return chunks;
}

/**
 * Process embeddings for multiple chunks and combine them
 */
function processChunkedEmbeddings(chunks, session) {
  const embeddings = [];

  for (const chunk of chunks) {
    const { ids } = chunk;
    const validIds = validateTokenIds(ids);

    const inputIds = new BigInt64Array(validIds.map((i) => BigInt(i)));
    const attentionMask = new BigInt64Array(validIds.length).fill(BigInt(1));
    const tokenTypeIds = new BigInt64Array(validIds.length).fill(BigInt(0));

    const inputTensor = new Tensor('int64', inputIds, [1, validIds.length]);
    const attentionTensor = new Tensor('int64', attentionMask, [1, validIds.length]);
    const tokenTypeTensor = new Tensor('int64', tokenTypeIds, [1, validIds.length]);

    const feeds = {
      input_ids: inputTensor,
      attention_mask: attentionTensor,
      token_type_ids: tokenTypeTensor
    };

    const results = session.run(feeds);
    const lastHiddenState = results['last_hidden_state'];
    if (!lastHiddenState)
      throw new Error(
        `ONNX model output 'last_hidden_state' not found. Available outputs: ${Object.keys(results).join(', ')}`
      );
    const [, sequenceLength, hiddenSize] = lastHiddenState.dims;
    const embeddingData = lastHiddenState.data;

    // Apply mean pooling across the sequence dimension
    const pooledEmbedding = new Float32Array(hiddenSize);
    for (let i = 0; i < hiddenSize; i++) {
      let sum = 0;
      for (let j = 0; j < sequenceLength; j++) {
        sum += embeddingData[j * hiddenSize + i];
      }
      pooledEmbedding[i] = sum / sequenceLength;
    }

    embeddings.push(pooledEmbedding);
  }

  // If multiple chunks, average the embeddings
  if (embeddings.length === 1) return embeddings[0];

  const hiddenSize = embeddings[0].length;
  const avgEmbedding = new Float32Array(hiddenSize);

  for (let i = 0; i < hiddenSize; i++) {
    let sum = 0;
    for (const embedding of embeddings) {
      sum += embedding[i];
    }
    avgEmbedding[i] = sum / embeddings.length;
  }

  return avgEmbedding;
}

let session = null;
let tokenizer = null;

async function createSession() {
  const modelDir = getModelDir();
  await downloadModelIfNeeded(modelDir, MODEL);
  ({ session, tokenizer } = await loadModelAndTokenizer(modelDir));
}

function embedding(text) {
  if (!session || !tokenizer)
    throw new Error(
      'Embedding session not initialized. Call createSession() before using embedding().'
    );
  const chunks = wordPieceTokenizer(text, tokenizer);
  const vector = normalizeEmbedding(processChunkedEmbeddings(chunks, session));

  const chunkObj = { content: text };
  return Object.defineProperty(chunkObj, 'embedding', {
    value: vector,
    writable: true,
    configurable: true,
    enumerable: false
  });

  function normalizeEmbedding(embedding) {
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return embedding; // Guard against division by zero
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] = embedding[i] / norm;
    }
    return embedding;
  }
}

/**
 * Get the platform-specific data directory for the application
 * @param {string} appName - The application name (defaults to 'semantic-search')
 * @returns {string} The full path to the data directory
 */
function getDataDir(appName = 'semantic-search') {
  const home = os.homedir();
  const dir =
    os.platform() === 'win32'
      ? process.env.LOCALAPPDATA || process.env.APPDATA || path.join(home, 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

  return path.join(dir, appName);
}

function getModelDir() {
  const cacheRoot = process.env.CDS_AI_MODEL_CACHE || path.join(getDataDir(), 'models');
  return path.join(cacheRoot, MODEL.repository.replace('/', '_'), MODEL.revision);
}

export default embedding;
export { embedding, createSession, wordPieceTokenizer };
