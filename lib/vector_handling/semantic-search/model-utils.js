import { InferenceSession } from './InferenceSession.js';
import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';

// File operations
async function fileExists(filePath) {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Failed to download ${url}, status ${res.status} (${res.statusText})`);
  const arrayBuffer = await res.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
}

// Model management
async function downloadModelIfNeeded(modelDir, files, modelName) {
  await fs.mkdir(modelDir, { recursive: true });
  // eslint-disable-next-line no-await-in-loop
  for (const file of files) {
    const filePath = path.join(modelDir, path.basename(file));
    // eslint-disable-next-line no-await-in-loop
    if (!(await fileExists(filePath)))
      // eslint-disable-next-line no-await-in-loop
      await downloadFile(`https://huggingface.co/${modelName}/resolve/main/${file}`, filePath);
  }
}

async function forceRedownloadModel(modelDir, files) {
  // eslint-disable-next-line no-await-in-loop
  for (const file of files) {
    const filePath = path.join(modelDir, path.basename(file));
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(filePath)) await fs.unlink(filePath).catch(() => {});
  }
}

async function loadModelAndVocab(modelDir) {
  const modelPath = path.join(modelDir, 'model.onnx');
  const vocabPath = path.join(modelDir, 'tokenizer.json');

  const session = await InferenceSession.create(await fs.readFile(modelPath));
  const tokenizerJson = JSON.parse(await fs.readFile(vocabPath, 'utf-8'));

  if (!tokenizerJson.model || !tokenizerJson.model.vocab)
    throw new Error('Invalid tokenizer structure: missing model.vocab');

  const cleanVocab = new Map();
  for (const [token, id] of Object.entries(tokenizerJson.model.vocab)) {
    if (typeof id === 'number') cleanVocab.set(token, id);
  }

  return { session, vocab: cleanVocab };
}

// Tokenization helpers
function preTokenize(text) {
  return (
    text
      .normalize('NFD')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[!\s]\p{P}[!\s]/gu, (p) => ` ${p} `)
      .split(/\s/g)
      .filter((a) => a)
  );
}

function wordPieceTokenize(token, vocab, unkToken = '[UNK]', maxInputCharsPerWord = 200) {
  if (token.length > maxInputCharsPerWord) return [unkToken];

  const outputTokens = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let currentSubstring = null;

    while (start < end) {
      let substring = token.substring(start, end);
      if (start > 0) substring = '##' + substring;
      if (vocab.has(substring)) {
        currentSubstring = substring;
        break;
      }
      end -= 1;
    }

    if (currentSubstring === null) return [unkToken];

    outputTokens.push(currentSubstring);
    start = end;
  }

  return outputTokens;
}

// Validate token IDs before conversion to BigInt
function validateTokenIds(ids) {
  ids.forEach((id) => {
    if (typeof id !== 'number' || isNaN(id) || !isFinite(id))
      throw new Error(`Invalid token ID detected: ${id} (type: ${typeof id})`);
  });
  return ids;
}

export {
  downloadModelIfNeeded,
  forceRedownloadModel,
  loadModelAndVocab,
  preTokenize,
  wordPieceTokenize,
  validateTokenIds
};
