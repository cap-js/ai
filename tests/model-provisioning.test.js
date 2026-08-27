import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { runModelCommand } from '../lib/vector_embedding/cli.js';
import { resolveEmbeddingModel } from '../lib/vector_embedding/embedding.js';
import {
  MODEL_LOCK_FILE,
  provisionModel,
  readModelLock,
  verifyModelDirectory
} from '../lib/vector_embedding/model-utils.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('runtime model configuration', () => {
  test('accepts only model and directory in runtime configuration', async () => {
    const model = fixtureModel(Buffer.from('configuration fixture'));
    await assert.rejects(
      resolveEmbeddingModel(),
      /cds\.env\.requires\.db\.embedding\.model must be a non-empty string/
    );
    await assert.rejects(
      resolveEmbeddingModel({}),
      /cds\.env\.requires\.db\.embedding\.model must be a non-empty string/
    );
    await assert.rejects(
      resolveEmbeddingModel(model.repository),
      /embedding must be an object with model and directory/
    );
    await assert.rejects(
      resolveEmbeddingModel({ ...model }),
      /Only model and directory are supported/
    );
    await assert.rejects(
      resolveEmbeddingModel({ model: model.repository }),
      /cds\.env\.requires\.db\.embedding\.directory must be a non-empty string/
    );
    await assert.rejects(
      resolveEmbeddingModel({ model: model.repository, directory: '' }),
      /cds\.env\.requires\.db\.embedding\.directory must be a non-empty string/
    );
  });
});

describe('explicit model provisioning', () => {
  test('downloads, verifies, and locks a model idempotently', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('verified model fixture');
    const model = fixtureModel(content);
    const requestedUrls = [];
    const fetchImpl = createFetch(content, requestedUrls);

    await provisionModel(model, { directory, fetchImpl });
    await provisionModel(model, { directory, fetchImpl });

    assert.deepEqual(
      requestedUrls,
      model.files.map(
        (file) => `https://huggingface.co/example/model/resolve/${model.revision}/${file.path}`
      )
    );
    assert.deepEqual(await readModelLock(directory), model);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, MODEL_LOCK_FILE), 'utf8')), {
      ...model,
      formatVersion: 1
    });
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      MODEL_LOCK_FILE,
      'model.onnx',
      'tokenizer.json',
      'tokenizer_config.json'
    ]);
    const modes = await Promise.all(
      [MODEL_LOCK_FILE, ...model.files.map(({ name }) => name)].map(async (file) =>
        fs.stat(path.join(directory, file)).then(({ mode }) => mode & 0o777)
      )
    );
    assert.deepEqual(modes, new Array(modes.length).fill(0o644));
  });

  test('restores readable permissions on already valid artifacts', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('readable model fixture');
    const model = fixtureModel(content);
    const modelPath = path.join(directory, model.files[0].name);
    await provisionModel(model, { directory, fetchImpl: createFetch(content) });
    await fs.chmod(modelPath, 0o600);

    await provisionModel(model, { directory, fetchImpl: createFetch(content) });

    assert.equal((await fs.stat(modelPath)).mode & 0o777, 0o644);
  });

  test('makes newly provisioned directories traversable across runtime users', async () => {
    const parent = await createTemporaryDirectory();
    const modelsDirectory = path.join(parent, 'models');
    const directory = path.join(modelsDirectory, 'custom');
    const content = Buffer.from('directory mode fixture');
    const baseModel = fixtureModel(content);
    const model = {
      ...baseModel,
      files: baseModel.files.map((file, index) =>
        index === 0 ? { ...file, name: 'onnx/model.onnx' } : file
      )
    };
    const originalUmask = process.umask(0o077);
    try {
      await provisionModel(model, { directory, fetchImpl: createFetch(content) });
    } finally {
      process.umask(originalUmask);
    }

    assert.equal((await fs.stat(modelsDirectory)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(directory, 'onnx'))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(directory, 'onnx/model.onnx'))).mode & 0o777, 0o644);
    assert.equal((await fs.stat(path.join(directory, MODEL_LOCK_FILE))).mode & 0o777, 0o644);
  });

  test('does not repurpose a directory locked to a different descriptor', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('locked model fixture');
    const model = fixtureModel(content);
    await provisionModel(model, { directory, fetchImpl: createFetch(content) });

    await assert.rejects(
      provisionModel({ ...model, repository: 'example/other-model' }, { directory }),
      /locked to a different model descriptor/
    );
    await assert.rejects(
      provisionModel({ ...model, dimensions: model.dimensions + 1 }, { directory }),
      /locked to a different model descriptor/
    );
    assert.deepEqual(await readModelLock(directory), model);
  });

  test('serializes provisioning attempts for the same directory', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('concurrent model fixture');
    const model = fixtureModel(content);
    let releaseDownload;
    let signalDownloadStarted;
    const downloadStarted = new Promise((resolve) => {
      signalDownloadStarted = resolve;
    });
    const waitForRelease = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    let firstRequest = true;
    const fetchImpl = async () => {
      if (firstRequest) {
        firstRequest = false;
        signalDownloadStarted();
        await waitForRelease;
      }
      return new Response(content);
    };

    const first = provisionModel(model, { directory, fetchImpl });
    await downloadStarted;
    await assert.rejects(
      provisionModel(model, { directory, fetchImpl }),
      /already being provisioned/
    );
    releaseDownload();
    await first;
  });

  test('recovers a stale install lock owned by a terminated local process', async () => {
    const parent = await createTemporaryDirectory();
    const directory = path.join(parent, 'model');
    const installLock = path.join(parent, '.model.embedding.install.lock');
    const content = Buffer.from('stale lock fixture');
    const model = fixtureModel(content);
    await fs.writeFile(
      installLock,
      JSON.stringify({
        formatVersion: 1,
        pid: 99999999,
        hostname: os.hostname(),
        createdAt: '2000-01-01T00:00:00.000Z',
        token: 'stale-owner'
      })
    );

    await provisionModel(model, { directory, fetchImpl: createFetch(content) });

    await assert.rejects(fs.access(installLock));
    assert.deepEqual(await readModelLock(directory), model);
  });

  test('recovers a stale install lock truncated by an interrupted write', async () => {
    const parent = await createTemporaryDirectory();
    const directory = path.join(parent, 'model');
    const installLock = path.join(parent, '.model.embedding.install.lock');
    const content = Buffer.from('truncated lock fixture');
    const model = fixtureModel(content);
    await fs.writeFile(installLock, '{');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    await fs.utimes(installLock, staleTime, staleTime);

    await provisionModel(model, { directory, fetchImpl: createFetch(content) });

    await assert.rejects(fs.access(installLock));
    assert.deepEqual(await readModelLock(directory), model);
  });

  test('rejects symlinked artifact path components', async () => {
    const directory = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const content = Buffer.from('symlink model fixture');
    const baseModel = fixtureModel(content);
    const model = {
      ...baseModel,
      files: baseModel.files.map((file, index) =>
        index === 0 ? { ...file, name: 'nested/model.onnx' } : file
      )
    };
    await fs.symlink(outside, path.join(directory, 'nested'), 'dir');

    await assert.rejects(
      provisionModel(model, { directory, fetchImpl: createFetch(content) }),
      /must not contain symbolic links/
    );
    assert.deepEqual(await fs.readdir(outside), []);
  });

  test('rejects a symlinked or replaced model directory', async () => {
    const parent = await createTemporaryDirectory();
    const directory = path.join(parent, 'model');
    const outside = await createTemporaryDirectory();
    const content = Buffer.from('root symlink fixture');
    const model = fixtureModel(content);
    await fs.symlink(outside, directory, 'dir');

    await assert.rejects(
      provisionModel(model, { directory, fetchImpl: createFetch(content) }),
      /model directory must not be a symbolic link/
    );
    assert.deepEqual(await fs.readdir(outside), []);
  });

  test('canonicalizes symlinked ancestor directories before provisioning', async () => {
    const parent = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const modelsDirectory = path.join(parent, 'models');
    const requestedDirectory = path.join(modelsDirectory, 'custom');
    const content = Buffer.from('ancestor symlink fixture');
    const model = fixtureModel(content);
    await fs.symlink(outside, modelsDirectory, 'dir');

    const directory = await provisionModel(model, {
      directory: requestedDirectory,
      fetchImpl: createFetch(content)
    });

    assert.equal(directory, path.join(await fs.realpath(outside), 'custom'));
    assert.deepEqual(await readModelLock(directory), model);
  });

  test('publishes from staging and detects replacement of the target during download', async () => {
    const parent = await createTemporaryDirectory();
    const directory = path.join(parent, 'model');
    const outside = await createTemporaryDirectory();
    const content = Buffer.from('target replacement fixture');
    const model = fixtureModel(content);
    let replaced = false;
    const fetchImpl = async () => {
      if (!replaced) {
        replaced = true;
        await fs.symlink(outside, directory, 'dir');
      }
      return new Response(content);
    };

    await assert.rejects(
      provisionModel(model, { directory, fetchImpl }),
      /model directory must not be a symbolic link/
    );
    assert.deepEqual(await fs.readdir(outside), []);
  });

  test('writes the lock only after every artifact passes verification', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('expected model fixture');
    const model = fixtureModel(content);

    await assert.rejects(
      provisionModel(model, {
        directory,
        fetchImpl: async () => new Response(Buffer.from('invalid'))
      }),
      /Invalid size|Invalid SHA-256/
    );
    await assert.rejects(fs.access(path.join(directory, MODEL_LOCK_FILE)));
  });

  test('fails verification instead of downloading missing runtime files', async () => {
    const directory = await createTemporaryDirectory();
    const model = fixtureModel(Buffer.from('fixture'));

    await assert.rejects(
      verifyModelDirectory(directory, model),
      new RegExp(`Embedding model is not provisioned.*${escapeRegExp(directory)}`, 's')
    );
    assert.deepEqual(await fs.readdir(directory), []);
  });

  test('keeps explicitly configured directories offline', async () => {
    const root = await createTemporaryDirectory();
    let fetched = false;
    await assert.rejects(
      resolveEmbeddingModel(
        {
          model: 'example/model',
          directory: './models/minilm'
        },
        {
          root,
          fetchImpl: () => {
            fetched = true;
            throw new Error('explicit directories must not fetch');
          }
        }
      ),
      /cds-ai model install --descriptor <path-to-embedding-model\.json> --directory \.\/models\/minilm/
    );
    assert.equal(fetched, false);
  });

  test('resolves relative directories from cds.root and preserves absolute directories', async () => {
    const root = await createTemporaryDirectory();
    const directory = path.join(root, 'models', 'custom');
    const content = Buffer.from('directory resolution fixture');
    const model = fixtureModel(content);
    await provisionModel(model, { directory, fetchImpl: createFetch(content) });

    const relative = await resolveEmbeddingModel(
      { model: model.repository, directory: './models/custom' },
      { root }
    );
    const absolute = await resolveEmbeddingModel(
      { model: model.repository, directory },
      { root: await createTemporaryDirectory() }
    );

    assert.equal(relative.modelDir, directory);
    assert.equal(absolute.modelDir, directory);
  });

  test('rejects a configured model name that does not match the provisioned lock', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('repository mismatch fixture');
    const model = fixtureModel(content);
    await provisionModel(model, { directory, fetchImpl: createFetch(content) });

    await assert.rejects(
      resolveEmbeddingModel({ model: 'example/other-model', directory }),
      /contains example\/model, not example\/other-model/
    );
  });

  test('gives models a descriptor-based provisioning command', async () => {
    const root = await createTemporaryDirectory();

    await assert.rejects(
      resolveEmbeddingModel({ model: 'example/custom', directory: './models/custom' }, { root }),
      /model install --descriptor <path-to-embedding-model\.json> --directory \.\/models\/custom/
    );
  });

  test('requires explicit lock recovery before reinstalling', async () => {
    const directory = await createTemporaryDirectory();
    await fs.writeFile(path.join(directory, MODEL_LOCK_FILE), '{}');

    await assert.rejects(
      resolveEmbeddingModel({ model: 'example/model', directory }),
      /Remove or replace the invalid lock explicitly, then run 'npx cds-ai model install/
    );
  });

  test('installs a descriptor through the command API', async () => {
    const root = await createTemporaryDirectory();
    const directory = path.join(root, 'models', 'custom');
    const descriptor = path.join(root, 'embedding-model.json');
    const content = Buffer.from('command fixture');
    const model = fixtureModel(content);
    const output = [];

    await fs.writeFile(descriptor, JSON.stringify(model));
    await runModelCommand(
      ['model', 'install', '--descriptor', descriptor, '--directory', directory],
      {
        cwd: root,
        fetchImpl: createFetch(content),
        stdout: { write: (value) => output.push(value) }
      }
    );

    assert.deepEqual(await readModelLock(directory), model);
    assert.match(output.join(''), /Provisioned example\/model/);
  });

  test('requires a descriptor and directory when provisioning', async () => {
    await assert.rejects(
      provisionModel(fixtureModel(Buffer.from('missing directory fixture'))),
      /non-empty provisioning directory is required/
    );
    await assert.rejects(
      runModelCommand(['model', 'install', '--descriptor', './embedding-model.json']),
      /--directory is required/
    );
    await assert.rejects(
      runModelCommand(['model', 'install', '--directory', './models/custom']),
      /--descriptor is required/
    );
    await assert.rejects(
      runModelCommand(['model', 'install', 'example/model', '--directory', './models/custom']),
      /Unexpected argument 'example\/model'/
    );
  });
});

function createFetch(content, requestedUrls = []) {
  return async (url) => {
    requestedUrls.push(url);
    return new Response(content, {
      headers: { 'content-length': String(content.length) }
    });
  };
}

async function createTemporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-provision-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureModel(content) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    repository: 'example/model',
    revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    dimensions: 2,
    maxLength: 8,
    files: [
      { role: 'model', name: 'model.onnx', path: 'onnx/model.onnx', size: content.length, sha256 },
      {
        role: 'tokenizer',
        name: 'tokenizer.json',
        path: 'tokenizer.json',
        size: content.length,
        sha256
      },
      {
        role: 'tokenizerConfig',
        name: 'tokenizer_config.json',
        path: 'tokenizer_config.json',
        size: content.length,
        sha256
      }
    ],
    output: { name: 'last_hidden_state', pooling: 'mean', normalize: true }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
