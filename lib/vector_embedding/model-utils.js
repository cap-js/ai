import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Tokenizer } from '@huggingface/tokenizers';
import { InferenceSession } from './InferenceSession.js';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const REQUIRED_FILE_ROLES = ['model', 'tokenizer', 'tokenizerConfig'];
const ALLOWED_FILE_ROLES = new Set([...REQUIRED_FILE_ROLES, 'auxiliary']);

function validateModelDescriptor(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new TypeError('The embedding model descriptor must be an object');
  }

  assertSafeRepository(model.repository);
  if (typeof model.revision !== 'string' || !/^[a-fA-F0-9]{40,64}$/.test(model.revision)) {
    throw new Error('embedding.revision must be an immutable 40-64 character commit hash');
  }
  if (!Number.isSafeInteger(model.dimensions) || model.dimensions < 1) {
    throw new Error('embedding.dimensions must be a positive integer');
  }
  if (!Number.isSafeInteger(model.maxLength) || model.maxLength < 1) {
    throw new Error('embedding.maxLength must be a positive integer');
  }
  if (!Array.isArray(model.files) || model.files.length < REQUIRED_FILE_ROLES.length) {
    throw new Error('embedding.files must include model, tokenizer, and tokenizerConfig files');
  }

  const names = new Set();
  const requiredRoles = new Set();
  for (const file of model.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError('Each embedding file descriptor must be an object');
    }
    if (!ALLOWED_FILE_ROLES.has(file.role)) {
      throw new Error(`Unsupported embedding file role '${file.role}'`);
    }
    if (file.role !== 'auxiliary' && requiredRoles.has(file.role)) {
      throw new Error(`Duplicate embedding file role '${file.role}'`);
    }
    requiredRoles.add(file.role);
    assertSafeRelativePath(file.name, `embedding.files[${file.role}].name`);
    assertSafeRelativePath(file.path, `embedding.files[${file.role}].path`);
    if (names.has(file.name)) throw new Error(`Duplicate embedding file name '${file.name}'`);
    names.add(file.name);
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      throw new Error(`Invalid size for embedding file '${file.name}'`);
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid SHA-256 for embedding file '${file.name}'`);
    }
  }
  for (const role of REQUIRED_FILE_ROLES) {
    if (!requiredRoles.has(role)) throw new Error(`Missing embedding file role '${role}'`);
  }

  const output = model.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('embedding.output must describe the model output');
  }
  if (typeof output.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(output.name)) {
    throw new Error('embedding.output.name must be a valid ONNX output name');
  }
  if (!['mean', 'cls', 'none'].includes(output.pooling)) {
    throw new Error("embedding.output.pooling must be 'mean', 'cls', or 'none'");
  }
  if (typeof output.normalize !== 'boolean') {
    throw new Error('embedding.output.normalize must be a boolean');
  }

  return model;
}

function assertSafeRepository(repository) {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('embedding.repository must be a safe Hugging Face repository ID');
  }
}

function assertSafeRelativePath(value, field) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function fileForRole(model, role) {
  return model.files.find((file) => file.role === role);
}

function artifactSetDigest(model) {
  const files = model.files
    .map(({ role, name, path: remotePath, size, sha256: checksum }) => ({
      role,
      name,
      path: remotePath,
      size,
      sha256: checksum
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = JSON.stringify({
    repository: model.repository,
    revision: model.revision.toLowerCase(),
    files
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function getModelCacheDir(cacheRoot, model) {
  validateModelDescriptor(model);
  return path.join(
    cacheRoot,
    ...model.repository.split('/'),
    model.revision.toLowerCase(),
    artifactSetDigest(model)
  );
}

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

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
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
  validateModelDescriptor(model);
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

async function loadModelAndTokenizer(modelDir, model) {
  const modelPath = path.join(modelDir, fileForRole(model, 'model').name);
  const tokenizerPath = path.join(modelDir, fileForRole(model, 'tokenizer').name);
  const tokenizerConfigPath = path.join(modelDir, fileForRole(model, 'tokenizerConfig').name);
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    fs.readFile(tokenizerPath, 'utf8').then(JSON.parse),
    fs.readFile(tokenizerConfigPath, 'utf8').then(JSON.parse)
  ]);

  return {
    session: await InferenceSession.create(modelPath),
    tokenizer: new Tokenizer(tokenizerJson, tokenizerConfig)
  };
}

export {
  downloadFile,
  downloadModelIfNeeded,
  artifactSetDigest,
  fileForRole,
  getModelCacheDir,
  isValidFile,
  loadModelAndTokenizer,
  validateModelDescriptor
};
