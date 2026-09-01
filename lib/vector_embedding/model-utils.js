import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MODEL_LOCK_FILE = 'embedding.lock.json';
const MODEL_INSTALL_LOCK_FILE = '.embedding.install.lock';
const MODEL_LOCK_VERSION = 2;
const MODEL_PROVISIONING_IN_PROGRESS = 'ERR_EMBEDDING_MODEL_PROVISIONING_IN_PROGRESS';
const INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;
const PROVISIONED_DIRECTORY_MODE = 0o755;
const PROVISIONED_FILE_MODE = 0o644;
const REQUIRED_FILE_ROLES = ['model', 'tokenizer', 'tokenizerConfig'];
const ALLOWED_FILE_ROLES = new Set([...REQUIRED_FILE_ROLES, 'auxiliary']);
const RESERVED_ARTIFACT_PATHS = [MODEL_LOCK_FILE, MODEL_INSTALL_LOCK_FILE];

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
    for (const existingName of names) assertNoPathCollision(file.name, existingName);
    for (const reservedPath of RESERVED_ARTIFACT_PATHS) {
      assertNoPathCollision(file.name, reservedPath, 'provisioning metadata');
    }
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
  if (typeof output.includePrompt !== 'boolean') {
    throw new Error('embedding.output.includePrompt must be a boolean');
  }

  if (model.prompts !== undefined) validatePrompts(model.prompts);
  if (model.prompts && !output.includePrompt) {
    throw new Error('Embedding prompts require embedding.output.includePrompt to be true');
  }

  return model;
}

function validatePrompts(prompts) {
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
    throw new Error('embedding.prompts must be an object with query and/or document string values');
  }
  const keys = Object.keys(prompts);
  if (keys.length === 0) {
    throw new Error('embedding.prompts must define at least one of query or document');
  }
  for (const key of keys) {
    if (key !== 'query' && key !== 'document') {
      throw new Error(`Unsupported embedding.prompts key '${key}'`);
    }
    if (typeof prompts[key] !== 'string' || !prompts[key]) {
      throw new Error(`embedding.prompts.${key} must be a non-empty string`);
    }
  }
}

function assertNoPathCollision(left, right, description = 'another embedding file') {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  ) {
    throw new Error(`Embedding file '${left}' conflicts with ${description} '${right}'`);
  }
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

function getModelRoot(directory, root = process.cwd(), home = os.homedir()) {
  if (directory === undefined) return path.join(root, '.cds', 'models');
  if (directory === '~') return home;
  if (/^~[\\/]/.test(directory)) return path.join(home, directory.slice(2));
  return path.resolve(root, directory);
}

function getModelDirectory(root, repository) {
  assertSafeRepository(repository);
  return path.join(root, ...repository.split('/'));
}

function assertSafeRelativePath(value, field) {
  const parts = typeof value === 'string' ? value.split('/') : [];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    parts.some((part) => part.endsWith('.') || isWindowsDeviceName(part)) ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function isWindowsDeviceName(value) {
  const basename = value.split('.')[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(basename);
}

function fileForRole(model, role) {
  return model.files.find((file) => file.role === role);
}

function modelDescriptorDigest(model) {
  validateModelDescriptor(model);
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
    dimensions: model.dimensions,
    maxLength: model.maxLength,
    files,
    output: {
      name: model.output.name,
      pooling: model.output.pooling,
      normalize: model.output.normalize,
      includePrompt: model.output.includePrompt
    },
    ...(model.prompts
      ? {
          prompts: {
            ...(model.prompts.query !== undefined ? { query: model.prompts.query } : {}),
            ...(model.prompts.document !== undefined ? { document: model.prompts.document } : {})
          }
        }
      : {})
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function isValidFile(filePath, file) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && stat.size === file.size && (await sha256(filePath)) === file.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyModelDirectory(modelDir, model) {
  validateModelDescriptor(model);
  await assertModelDirectory(modelDir);
  const validity = await Promise.all(
    model.files.map(async (file) => {
      await assertNoSymlinkComponents(modelDir, file.name);
      return {
        file,
        valid: await isValidFile(path.join(modelDir, file.name), file)
      };
    })
  );
  const invalid = validity.filter(({ valid }) => !valid).map(({ file }) => file.name);
  if (invalid.length > 0) {
    throw new Error(
      `Embedding model is not provisioned or failed integrity checks in ${modelDir}. Missing or invalid files: ${invalid.join(', ')}`
    );
  }
  return modelDir;
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
    handle = await fs.open(temporaryPath, 'wx', PROVISIONED_FILE_MODE);
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

    await fs.chmod(temporaryPath, PROVISIONED_FILE_MODE);

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
    await fs.chmod(outputPath, PROVISIONED_FILE_MODE);
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
  await ensureDirectory(modelDir);
  const hubUrl = normalizeHubUrl(options.hubUrl);

  for (const file of model.files) {
    const filePath = path.join(modelDir, file.name);
    // eslint-disable-next-line no-await-in-loop
    await prepareArtifactPath(modelDir, file.name);
    // eslint-disable-next-line no-await-in-loop
    if (await isValidFile(filePath, file)) {
      // Keep build-time provisioning readable when the runtime uses another UID.
      // eslint-disable-next-line no-await-in-loop
      await fs.chmod(filePath, PROVISIONED_FILE_MODE);
      continue;
    }

    const url = `${hubUrl}/${model.repository}/resolve/${model.revision}/${file.path}`;
    // Files are downloaded serially to avoid multiplying startup bandwidth and memory usage.
    // eslint-disable-next-line no-await-in-loop
    await downloadFile(url, filePath, file, options);
  }
}

function normalizeHubUrl(value = 'https://huggingface.co') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('The Hugging Face Hub URL must be a non-empty string');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new TypeError('The Hugging Face Hub URL must be a valid HTTPS URL', { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new TypeError('The Hugging Face Hub URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new TypeError('The Hugging Face Hub URL must not include credentials');
  }
  if (url.search || url.hash) {
    throw new TypeError('The Hugging Face Hub URL must not include a query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

async function prepareArtifactPath(modelDir, relativePath) {
  await assertNoSymlinkComponents(modelDir, relativePath);
  let current = modelDir;
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, part);
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(current, { mode: PROVISIONED_DIRECTORY_MODE }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Embedding artifact path must not contain symbolic links: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Embedding artifact parent is not a directory: ${current}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await fs.chmod(current, PROVISIONED_DIRECTORY_MODE);
  }
  await assertNoSymlinkComponents(modelDir, relativePath);
}

async function assertNoSymlinkComponents(modelDir, relativePath) {
  const exists = await assertModelDirectory(modelDir);
  if (!exists) return;
  let current = modelDir;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Embedding artifact path must not contain symbolic links: ${current}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Embedding artifact parent is not a directory: ${current}`);
    }
  }
}

async function assertModelDirectory(modelDir) {
  try {
    const stat = await fs.lstat(modelDir);
    if (stat.isSymbolicLink()) {
      throw new Error(`Embedding model directory must not be a symbolic link: ${modelDir}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Embedding model path is not a directory: ${modelDir}`);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureDirectory(directory) {
  await ensureParentDirectories(directory);
  await assertModelDirectory(directory);
  await fs.chmod(directory, PROVISIONED_DIRECTORY_MODE);
}

async function ensureParentDirectories(directory) {
  const missing = [];
  let current = directory;
  // eslint-disable-next-line no-await-in-loop
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const missingDirectory of missing.reverse()) {
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(missingDirectory, { mode: PROVISIONED_DIRECTORY_MODE }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    // Explicit chmod avoids umask making build-time model directories unreadable at runtime.
    // eslint-disable-next-line no-await-in-loop
    await fs.chmod(missingDirectory, PROVISIONED_DIRECTORY_MODE);
  }
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalizeProvisioningDirectory(directory) {
  const requestedDirectory = path.resolve(directory);
  let current = requestedDirectory;
  const missing = [];

  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.lstat(current);
      if (current === requestedDirectory && stat.isSymbolicLink()) {
        throw new Error(`Embedding model directory must not be a symbolic link: ${directory}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const canonicalAncestor = await fs.realpath(current);
      // eslint-disable-next-line no-await-in-loop
      const canonicalStat = await fs.stat(canonicalAncestor);
      if (!canonicalStat.isDirectory()) {
        throw new Error(`Embedding model path is not a directory: ${current}`);
      }
      return path.join(canonicalAncestor, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function readModelLock(modelDir) {
  const lockPath = path.join(modelDir, MODEL_LOCK_FILE);
  let lock;
  try {
    await assertModelDirectory(modelDir);
    const stat = await fs.lstat(lockPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Embedding model lock must not be a symbolic link at ${lockPath}`);
    }
    lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Embedding model lock not found at ${lockPath}`, { cause: error });
    }
    throw new Error(`Cannot read embedding model lock at ${lockPath}: ${error.message}`, {
      cause: error
    });
  }
  if (lock.formatVersion !== MODEL_LOCK_VERSION) {
    if (lock.formatVersion === 1) {
      throw new Error(
        `Embedding model lock version 1 at ${lockPath} predates prompt semantics; remove and reinstall the model`
      );
    }
    throw new Error(
      `Unsupported embedding model lock version ${lock.formatVersion ?? 'missing'} at ${lockPath}`
    );
  }
  const { formatVersion, ...model } = lock;
  void formatVersion;
  return validateModelDescriptor(model);
}

async function writeModelLock(modelDir, model) {
  const lockPath = path.join(modelDir, MODEL_LOCK_FILE);
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify({ ...model, formatVersion: MODEL_LOCK_VERSION }, null, 2)}\n`;
  let handle;
  try {
    await ensureDirectory(modelDir);
    handle = await fs.open(temporaryPath, 'wx', PROVISIONED_FILE_MODE);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temporaryPath, PROVISIONED_FILE_MODE);
    await fs.rename(temporaryPath, lockPath);
    await fs.chmod(lockPath, PROVISIONED_FILE_MODE);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function provisionModel(model, options = {}) {
  validateModelDescriptor(model);
  if (typeof options.directory !== 'string' || !options.directory.trim()) {
    throw new Error('A non-empty provisioning directory is required');
  }
  const requestedDirectory = path.resolve(options.directory);
  const directory = await canonicalizeProvisioningDirectory(requestedDirectory);
  await ensureParentDirectories(path.dirname(directory));

  return withInstallLock(directory, async () => {
    const directoryExists = await assertModelDirectory(directory);
    let lockedModel;
    try {
      lockedModel = await readModelLock(directory);
      if (modelDescriptorDigest(lockedModel) !== modelDescriptorDigest(model)) {
        throw new Error(
          `Embedding model directory ${directory} is locked to a different model descriptor for ${lockedModel.repository}@${lockedModel.revision}. Choose another directory or remove it explicitly.`
        );
      }
    } catch (error) {
      if (!/Embedding model lock not found/.test(error.message)) throw error;
    }

    if (directoryExists) {
      try {
        await verifyModelDirectory(directory, model);
        if (!lockedModel) await writeModelLock(directory, model);
        await makeModelDirectoryReadable(directory, model);
        await options.validate?.(directory, model);
        return directory;
      } catch (error) {
        if (/symbolic link/.test(error.message)) throw error;
        if (!lockedModel && (await directoryHasEntries(directory))) {
          throw new Error(
            `Embedding model directory ${directory} is not empty and has no valid lock. Choose an empty directory or remove its contents explicitly.`,
            { cause: error }
          );
        }
      }
    }

    const stagingDirectory = await createStagingDirectory(directory);
    let published = false;
    try {
      await downloadModelIfNeeded(stagingDirectory, model, options);
      await verifyModelDirectory(stagingDirectory, model);
      await writeModelLock(stagingDirectory, model);
      await options.validate?.(stagingDirectory, model);
      await publishModelDirectory(stagingDirectory, directory);
      published = true;
    } finally {
      if (!published) await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
    return directory;
  });
}

async function withInstallLock(directory, callback) {
  const lockPath = path.join(
    path.dirname(directory),
    `.${path.basename(directory)}${MODEL_INSTALL_LOCK_FILE}`
  );
  const owner = {
    formatVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    token: randomUUID()
  };
  let handle;
  let heartbeat;
  try {
    handle = await acquireInstallLock(lockPath, directory, owner);
    heartbeat = setInterval(
      () => {
        const now = new Date();
        fs.utimes(lockPath, now, now).catch(() => {});
      },
      Math.min(INSTALL_LOCK_STALE_MS / 3, 60 * 1000)
    );
    heartbeat.unref();
    return await callback();
  } finally {
    clearInterval(heartbeat);
    await handle?.close().catch(() => {});
    if (handle) await releaseInstallLock(lockPath, owner);
  }
}

async function acquireInstallLock(lockPath, directory, owner) {
  try {
    return await createInstallLock(lockPath, owner);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await recoverStaleInstallLock(lockPath)) {
      return createInstallLock(lockPath, owner);
    }
    throw Object.assign(
      new Error(`Embedding model directory ${directory} is already being provisioned`, {
        cause: error
      }),
      { code: MODEL_PROVISIONING_IN_PROGRESS }
    );
  }
}

async function createInstallLock(lockPath, owner) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await fs.unlink(lockPath).catch(() => {});
    throw error;
  }
}

async function recoverStaleInstallLock(lockPath) {
  let contents;
  let stat;
  try {
    [contents, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.lstat(lockPath)]);
  } catch (error) {
    return error.code === 'ENOENT';
  }

  let owner;
  try {
    owner = JSON.parse(contents);
  } catch {
    if (Date.now() - stat.mtimeMs <= INSTALL_LOCK_STALE_MS) return false;
  }
  if (!isStaleInstallLock(owner, stat)) return false;

  const stalePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await fs.rename(lockPath, stalePath);
    const movedContents = await fs.readFile(stalePath, 'utf8');
    if (movedContents !== contents) {
      await fs.rename(stalePath, lockPath).catch(() => {});
      return false;
    }
    await fs.unlink(stalePath);
    return true;
  } catch (error) {
    await fs.unlink(stalePath).catch(() => {});
    return error.code === 'ENOENT';
  }
}

function isStaleInstallLock(owner, stat) {
  if (!owner || typeof owner !== 'object') {
    return Date.now() - stat.mtimeMs > INSTALL_LOCK_STALE_MS;
  }
  if (owner.hostname === os.hostname() && Number.isSafeInteger(owner.pid)) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'EPERM') return false;
      if (error.code === 'ESRCH') return true;
      return false;
    }
  }
  return Date.now() - stat.mtimeMs > INSTALL_LOCK_STALE_MS;
}

async function releaseInstallLock(lockPath, owner) {
  try {
    const currentOwner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (currentOwner.token === owner.token) await fs.unlink(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function createStagingDirectory(directory) {
  const parent = path.dirname(directory);
  const stagingDirectory = await fs.mkdtemp(
    path.join(parent, `.${path.basename(directory)}.staging-`)
  );
  await fs.chmod(stagingDirectory, PROVISIONED_DIRECTORY_MODE);
  return stagingDirectory;
}

async function publishModelDirectory(stagingDirectory, directory) {
  const targetExists = await assertModelDirectory(directory);
  let backupDirectory;
  if (targetExists) {
    backupDirectory = path.join(
      path.dirname(directory),
      `.${path.basename(directory)}.${randomUUID()}.backup`
    );
    await fs.rename(directory, backupDirectory);
  }

  try {
    await fs.rename(stagingDirectory, directory);
  } catch (error) {
    if (backupDirectory) await fs.rename(backupDirectory, directory).catch(() => {});
    throw error;
  }
  if (backupDirectory) await fs.rm(backupDirectory, { recursive: true, force: true });
}

async function directoryHasEntries(directory) {
  return (await fs.readdir(directory)).length > 0;
}

async function makeModelDirectoryReadable(directory, model) {
  await fs.chmod(directory, PROVISIONED_DIRECTORY_MODE);
  for (const file of model.files) {
    let current = directory;
    for (const part of file.name.split('/').slice(0, -1)) {
      current = path.join(current, part);
      // eslint-disable-next-line no-await-in-loop
      await fs.chmod(current, PROVISIONED_DIRECTORY_MODE);
    }
    // eslint-disable-next-line no-await-in-loop
    await fs.chmod(path.join(directory, file.name), PROVISIONED_FILE_MODE);
  }
  await fs.chmod(path.join(directory, MODEL_LOCK_FILE), PROVISIONED_FILE_MODE);
}

async function loadModelAndTokenizer(modelDir, model) {
  const [{ Tokenizer }, { SynchronousInferenceSession }] = await Promise.all([
    loadTokenizerPackage(),
    import('./SynchronousInferenceSession.js')
  ]);
  const modelPath = path.join(modelDir, fileForRole(model, 'model').name);
  const tokenizerPath = path.join(modelDir, fileForRole(model, 'tokenizer').name);
  const tokenizerConfigPath = path.join(modelDir, fileForRole(model, 'tokenizerConfig').name);
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    fs.readFile(tokenizerPath, 'utf8').then(JSON.parse),
    fs.readFile(tokenizerConfigPath, 'utf8').then(JSON.parse)
  ]);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

  return {
    session: await SynchronousInferenceSession.create(modelPath),
    tokenizer
  };
}

async function loadTokenizerPackage(importModule = (specifier) => import(specifier)) {
  try {
    return await importModule('@huggingface/tokenizers');
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      /Cannot find package ['"]@huggingface\/tokenizers['"]/.test(error.message)
    ) {
      throw new Error(
        "Using local SQLite embeddings requires @huggingface/tokenizers@0.1.3. Install it with 'npm add -D @huggingface/tokenizers@0.1.3'.",
        { cause: error }
      );
    }
    throw error;
  }
}

export {
  MODEL_LOCK_FILE,
  MODEL_LOCK_VERSION,
  MODEL_PROVISIONING_IN_PROGRESS,
  assertSafeRepository,
  downloadFile,
  downloadModelIfNeeded,
  fileForRole,
  getModelDirectory,
  getModelRoot,
  isValidFile,
  loadModelAndTokenizer,
  loadTokenizerPackage,
  modelDescriptorDigest,
  normalizeHubUrl,
  provisionModel,
  readModelLock,
  verifyModelDirectory,
  validateModelDescriptor
};
