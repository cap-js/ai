import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { InferenceSession } from './InferenceSession.js';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function isValidFile(filePath, file) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size === file.size && (await sha256(filePath)) === file.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function downloadFile(url, outputPath, file, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Failed to download ${url}, status ${response.status} (${response.statusText})`
      );
    }
    if (!response.body) throw new Error(`Failed to download ${url}: response has no body`);

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > file.size) {
      throw new Error(`Refusing ${url}: response exceeds the expected ${file.size} bytes`);
    }

    handle = await fs.open(temporaryPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytesWritten = 0;

    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytesWritten += chunk.byteLength;
      if (bytesWritten > file.size) {
        throw new Error(`Refusing ${url}: response exceeds the expected ${file.size} bytes`);
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
    }

    await handle.sync();
    await handle.close();
    handle = undefined;

    if (bytesWritten !== file.size) {
      throw new Error(`Invalid size for ${url}: expected ${file.size}, received ${bytesWritten}`);
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      throw new Error(`Invalid SHA-256 for ${url}: expected ${file.sha256}, received ${digest}`);
    }

    try {
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      if (await isValidFile(outputPath, file)) await fs.unlink(temporaryPath);
      else {
        await fs.unlink(outputPath).catch(() => {});
        await fs.rename(temporaryPath, outputPath);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Timed out after ${timeoutMs} ms while downloading ${url}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function downloadModelIfNeeded(modelDir, model, options) {
  await fs.mkdir(modelDir, { recursive: true });

  for (const file of model.files) {
    const filePath = path.join(modelDir, file.name);
    // eslint-disable-next-line no-await-in-loop
    if (await isValidFile(filePath, file)) continue;

    const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.path}`;
    // Files are downloaded serially to avoid multiplying startup bandwidth and memory usage.
    // eslint-disable-next-line no-await-in-loop
    await downloadFile(url, filePath, file, options);
  }
}

async function loadModelAndTokenizer(modelDir) {
  const modelPath = path.join(modelDir, 'model.onnx');
  const tokenizerPath = path.join(modelDir, 'tokenizer.json');
  const tokenizerJson = JSON.parse(await fs.readFile(tokenizerPath, 'utf8'));

  if (!tokenizerJson.model?.vocab) {
    throw new Error('Invalid tokenizer structure: missing model.vocab');
  }

  const vocab = new Map();
  for (const [token, id] of Object.entries(tokenizerJson.model.vocab)) {
    if (Number.isSafeInteger(id) && id >= 0) vocab.set(token, id);
  }

  const maxLength = tokenizerJson.truncation?.max_length;
  if (!Number.isSafeInteger(maxLength) || maxLength < 2) {
    throw new Error('Invalid tokenizer structure: missing truncation.max_length');
  }

  const session = await InferenceSession.create(modelPath);
  return {
    session,
    tokenizer: {
      vocab,
      maxLength,
      normalizer: tokenizerJson.normalizer ?? {}
    }
  };
}

function preTokenize(text, normalizer = {}) {
  const {
    clean_text: cleanText = true,
    handle_chinese_chars: handleChineseChars = true,
    lowercase = true,
    strip_accents: configuredStripAccents
  } = normalizer;
  const stripAccents = configuredStripAccents ?? lowercase;
  let normalized = String(text);

  if (cleanText) {
    normalized = Array.from(normalized, (character) => {
      if (/\s/u.test(character)) return ' ';
      if (character.codePointAt(0) === 0 || character.codePointAt(0) === 0xfffd) return '';
      if (/[\p{Cc}\p{Cf}]/u.test(character)) return '';
      return character;
    }).join('');
  }

  if (handleChineseChars) {
    normalized = Array.from(normalized, (character) =>
      isChineseCharacter(character.codePointAt(0)) ? ` ${character} ` : character
    ).join('');
  }

  const output = [];
  for (let token of normalized.trim().split(/\s+/u)) {
    if (!token) continue;
    if (lowercase) token = token.toLowerCase();
    if (stripAccents) token = token.normalize('NFD').replace(/\p{M}/gu, '');

    let current = '';
    for (const character of token) {
      if (/\p{P}/u.test(character)) {
        if (current) output.push(current);
        output.push(character);
        current = '';
      } else current += character;
    }
    if (current) output.push(current);
  }
  return output;
}

function isChineseCharacter(codePoint) {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
  );
}

function wordPieceTokenize(token, vocab, unkToken = '[UNK]', maxInputCharsPerWord = 100) {
  if (Array.from(token).length > maxInputCharsPerWord) return [unkToken];

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

function validateTokenIds(ids) {
  ids.forEach((id) => {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error(`Invalid token ID detected: ${id} (type: ${typeof id})`);
    }
  });
  return ids;
}

export {
  downloadFile,
  downloadModelIfNeeded,
  isValidFile,
  loadModelAndTokenizer,
  preTokenize,
  wordPieceTokenize,
  validateTokenIds
};
