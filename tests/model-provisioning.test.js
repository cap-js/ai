import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { runModelCommand } from '../lib/vector_embedding/cli.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  resolveEmbeddingModel
} from '../lib/vector_embedding/embedding.js';
import {
  MODEL_LOCK_FILE,
  MODEL_LOCK_VERSION,
  getModelDirectory,
  getModelRoot,
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
  test('uses the default model when no model is configured', async () => {
    const content = Buffer.from('default configuration fixture');
    const model = fixtureModel(content, DEFAULT_EMBEDDING_MODEL);
    const root = await createTemporaryDirectory();
    const modelDir = getModelDirectory(getModelRoot('.cds/models', root), model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    const resolved = await resolveEmbeddingModel(undefined, { root });

    assert.equal(resolved.modelDir, modelDir);
    assert.deepEqual(resolved.model, model);
  });

  test('uses the default model with a configured cache root', async () => {
    const content = Buffer.from('default shared-cache fixture');
    const model = fixtureModel(content, DEFAULT_EMBEDDING_MODEL);
    const directory = await createTemporaryDirectory();
    const modelDir = getModelDirectory(directory, model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    const resolved = await resolveEmbeddingModel({ directory });

    assert.equal(resolved.modelDir, modelDir);
    assert.deepEqual(resolved.model, model);
  });

  test('validates explicit model and directory while allowing additional properties', async () => {
    const content = Buffer.from('configuration fixture');
    const model = fixtureModel(content);
    await assert.rejects(
      resolveEmbeddingModel({ model: '' }),
      /cds\.env\.requires\.db\.embedding\.model must be a non-empty string/
    );
    await assert.rejects(
      resolveEmbeddingModel({ model: 42 }),
      /cds\.env\.requires\.db\.embedding\.model must be a non-empty string/
    );
    await assert.rejects(
      resolveEmbeddingModel({ model: null }),
      /cds\.env\.requires\.db\.embedding\.model must be a non-empty string/
    );
    await assert.rejects(resolveEmbeddingModel(model.repository), /embedding must be an object/);
    await assert.rejects(
      resolveEmbeddingModel({ model: model.repository, directory: '' }),
      /embedding\.directory must be a non-empty string/
    );

    const directory = await createTemporaryDirectory();
    const modelDir = getModelDirectory(directory, model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    const resolved = await resolveEmbeddingModel({
      model: model.repository,
      directory,
      revision: 'main',
      extension: { enabled: true }
    });

    assert.equal(resolved.modelDir, modelDir);
    assert.deepEqual(resolved.model, model);
  });

  test('merges configured prompts over discovered prompts per text type', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('prompt merge fixture');
    const model = {
      ...fixtureModel(content),
      prompts: { query: 'query: ', document: 'document: ' }
    };
    const modelDir = getModelDirectory(directory, model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    const resolved = await resolveEmbeddingModel({
      model: model.repository,
      directory,
      prompts: { query: 'custom query: ' }
    });

    assert.deepEqual(resolved.model.prompts, {
      query: 'custom query: ',
      document: 'document: '
    });
    assert.deepEqual(await readModelLock(modelDir), model);
  });

  test('rejects configured prompts when prompt tokens are excluded from pooling', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('prompt exclusion fixture');
    const base = fixtureModel(content);
    const model = { ...base, output: { ...base.output, includePrompt: false } };
    const modelDir = getModelDirectory(directory, model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    await assert.rejects(
      resolveEmbeddingModel({
        model: model.repository,
        directory,
        prompts: { query: 'query: ' }
      }),
      /excludes prompt tokens from pooling/
    );
  });
});

describe('default model caches', () => {
  test('prefers the project model over a different revision in the home cache', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('project override fixture');
    const model = fixtureModel(content);
    const homeModel = { ...model, revision: '1'.repeat(40) };
    const projectDirectory = getModelDirectory(getModelRoot('.cds/models', root), model.repository);
    const homeDirectory = getModelDirectory(getModelRoot(undefined, root, home), model.repository);
    await provisionModel(model, { directory: projectDirectory, fetchImpl: createFetch(content) });
    await provisionModel(homeModel, { directory: homeDirectory, fetchImpl: createFetch(content) });

    const resolved = await resolveEmbeddingModel(
      { model: model.repository },
      { root, home, fetchImpl: () => assert.fail('cached models must not fetch') }
    );

    assert.equal(resolved.modelDir, projectDirectory);
    assert.deepEqual(resolved.model, model);
    assert.deepEqual(await readModelLock(homeDirectory), homeModel);
  });

  test('uses an installed home model without discovery or downloads', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('home fallback fixture');
    const model = fixtureModel(content);
    const modelDir = getModelDirectory(getModelRoot(undefined, root, home), model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    const resolved = await resolveEmbeddingModel(
      { model: model.repository },
      { root, home, fetchImpl: () => assert.fail('home cache must not fetch') }
    );

    assert.equal(resolved.modelDir, modelDir);
    assert.deepEqual(resolved.model, model);
    await assert.rejects(fs.access(path.join(root, '.cds')), /ENOENT/);
  });

  test('does not bypass or modify a project model with missing, malformed, or mismatched locks', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('invalid project fixture');
    const model = fixtureModel(content);
    const projectDirectory = getModelDirectory(getModelRoot('.cds/models', root), model.repository);
    const homeDirectory = getModelDirectory(getModelRoot(undefined, root, home), model.repository);
    await provisionModel(model, { directory: homeDirectory, fetchImpl: createFetch(content) });
    await fs.mkdir(projectDirectory, { recursive: true });
    const resolve = () =>
      resolveEmbeddingModel(
        { model: model.repository },
        { root, home, fetchImpl: () => assert.fail('invalid project overrides must not fetch') }
      );

    await assert.rejects(resolve(), /lock not found.*--directory \.cds\/models/);
    assert.deepEqual(await fs.readdir(projectDirectory), []);

    const lockPath = path.join(projectDirectory, MODEL_LOCK_FILE);
    await fs.writeFile(lockPath, '{}');
    await assert.rejects(resolve(), /invalid lock explicitly.*--directory \.cds\/models/);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{}');

    const mismatch = JSON.stringify({
      ...model,
      repository: 'example/other',
      formatVersion: MODEL_LOCK_VERSION
    });
    await fs.writeFile(lockPath, mismatch);
    await assert.rejects(resolve(), /contains example\/other, not example\/model/);
    assert.equal(await fs.readFile(lockPath, 'utf8'), mismatch);
  });

  test('does not repair invalid project artifacts or fall back to home', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('damaged project fixture');
    const model = fixtureModel(content);
    const projectDirectory = getModelDirectory(getModelRoot('.cds/models', root), model.repository);
    const homeDirectory = getModelDirectory(getModelRoot(undefined, root, home), model.repository);
    await provisionModel(model, { directory: projectDirectory, fetchImpl: createFetch(content) });
    await provisionModel(model, { directory: homeDirectory, fetchImpl: createFetch(content) });
    const modelPath = path.join(projectDirectory, 'model.onnx');
    await fs.writeFile(modelPath, 'damaged');

    await assert.rejects(
      resolveEmbeddingModel(
        { model: model.repository },
        { root, home, fetchImpl: () => assert.fail('project artifacts must not be repaired') }
      ),
      /failed integrity checks.*--directory \.cds\/models/
    );
    assert.equal(await fs.readFile(modelPath, 'utf8'), 'damaged');
  });

  test('repairs a home model using its existing lock without rediscovery', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('damaged home fixture');
    const model = fixtureModel(content);
    const modelDir = getModelDirectory(getModelRoot(undefined, root, home), model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });
    await fs.writeFile(path.join(modelDir, 'model.onnx'), 'damaged');
    const requestedUrls = [];

    const resolved = await resolveEmbeddingModel(
      { model: model.repository },
      {
        root,
        home,
        fetchImpl: createFetch(content, requestedUrls),
        discover: () => assert.fail('repair must reuse the installed lock'),
        validate: async () => {},
        warn() {}
      }
    );

    assert.equal(resolved.modelDir, modelDir);
    assert.deepEqual(await readModelLock(modelDir), model);
    await verifyModelDirectory(modelDir, model);
    assert.equal(requestedUrls.length, model.files.length);
    await assert.rejects(fs.access(path.join(root, '.cds')), /ENOENT/);
  });

  test('rejects malformed home locks without downloads', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const modelDir = path.join(home, '.cds', 'models', 'example', 'model');
    await fs.mkdir(modelDir, { recursive: true });
    await fs.writeFile(path.join(modelDir, MODEL_LOCK_FILE), '{}');

    await assert.rejects(
      resolveEmbeddingModel(
        { model: 'example/model' },
        {
          root,
          home,
          fetchImpl: () => assert.fail('malformed locks must not trigger downloads')
        }
      ),
      /Remove or replace the invalid lock explicitly/
    );
  });

  test('an explicit missing cache does not fall back to an installed home model', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('explicit cache fixture');
    const model = fixtureModel(content);
    await provisionModel(model, {
      directory: getModelDirectory(getModelRoot(undefined, root, home), model.repository),
      fetchImpl: createFetch(content)
    });

    await assert.rejects(
      resolveEmbeddingModel(
        { model: model.repository, directory: './custom' },
        {
          root,
          home,
          fetchImpl: () => assert.fail('explicit caches must stay offline')
        }
      ),
      /lock not found.*--directory \.\/custom/
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
      formatVersion: MODEL_LOCK_VERSION
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
    await assert.rejects(
      provisionModel(
        { ...model, output: { ...model.output, includePrompt: false } },
        { directory }
      ),
      /locked to a different model descriptor/
    );
    await assert.rejects(
      provisionModel({ ...model, prompts: { query: 'query: ' } }, { directory }),
      /locked to a different model descriptor/
    );
    assert.deepEqual(await readModelLock(directory), model);
  });

  test('rejects legacy model locks that predate prompt semantics', async () => {
    const directory = await createTemporaryDirectory();
    const model = fixtureModel(Buffer.from('legacy lock fixture'));
    const { includePrompt, ...legacyOutput } = model.output;
    void includePrompt;
    await fs.writeFile(
      path.join(directory, MODEL_LOCK_FILE),
      JSON.stringify({ ...model, output: legacyOutput, formatVersion: 1 })
    );

    await assert.rejects(
      readModelLock(directory),
      /version 1.*predates prompt semantics.*reinstall/
    );
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

  test('validates the runtime before publishing a newly installed model', async () => {
    const parent = await createTemporaryDirectory();
    const directory = path.join(parent, 'model');
    const content = Buffer.from('runtime validation fixture');
    const model = fixtureModel(content);
    let stagedDirectory;

    await assert.rejects(
      provisionModel(model, {
        directory,
        fetchImpl: createFetch(content),
        validate(candidate) {
          stagedDirectory = candidate;
          throw new Error('incompatible ONNX runtime');
        }
      }),
      /incompatible ONNX runtime/
    );

    assert.notEqual(stagedDirectory, directory);
    await assert.rejects(fs.access(directory));
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

  test('downloads a missing model into the home cache and reuses it across projects', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('lazy download fixture');
    const model = fixtureModel(content);
    const requestedUrls = [];
    const warnings = [];
    let discoveries = 0;
    const prompts = { query: 'query: ' };
    const options = {
      root,
      home,
      fetchImpl: createFetch(content, requestedUrls),
      discover(name) {
        discoveries++;
        assert.equal(name, model.repository);
        return model;
      },
      validate: async () => {},
      warn: (message) => warnings.push(message)
    };

    const first = await resolveEmbeddingModel({ model: model.repository, prompts }, options);
    const expectedDirectory = getModelDirectory(
      getModelRoot(undefined, root, home),
      model.repository
    );

    assert.deepEqual(first.model, { ...model, prompts });
    assert.equal(first.modelDir, expectedDirectory);
    assert.equal(discoveries, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Downloading it now; application startup may be delayed/);
    assert.match(warnings[0], /repositories you trust/);
    assert.ok(warnings[0].includes(expectedDirectory));
    assert.equal(requestedUrls.length, model.files.length);
    assert.deepEqual(await readModelLock(expectedDirectory), model);
    await assert.rejects(fs.access(path.join(root, '.cds', 'models')), /ENOENT/);

    const otherRoot = await createTemporaryDirectory();
    const second = await resolveEmbeddingModel(
      { model: model.repository, prompts },
      { ...options, root: otherRoot }
    );
    assert.deepEqual(second.model, { ...model, prompts });
    assert.equal(second.modelDir, expectedDirectory);
    assert.equal(discoveries, 1);
    assert.equal(warnings.length, 1);
    assert.equal(requestedUrls.length, model.files.length);
    await assert.rejects(fs.access(path.join(otherRoot, '.cds', 'models')), /ENOENT/);
  });

  test('waits for concurrent ad-hoc provisioning and reuses the completed download', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('concurrent lazy download fixture');
    const model = fixtureModel(content);
    const requestedUrls = [];
    const warnings = [];
    let releaseDownload;
    let signalDownloadStarted;
    let firstRequest = true;
    const downloadStarted = new Promise((resolve) => {
      signalDownloadStarted = resolve;
    });
    const waitForRelease = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    const fetchImpl = async (url) => {
      requestedUrls.push(url);
      if (firstRequest) {
        firstRequest = false;
        signalDownloadStarted();
        await waitForRelease;
      }
      return new Response(content, {
        headers: { 'content-length': String(content.length) }
      });
    };
    const options = {
      root,
      home,
      fetchImpl,
      discover: () => model,
      validate: async () => {},
      warn: (message) => warnings.push(message),
      provisionRetryMs: 5,
      provisionTimeoutMs: 1000
    };

    const first = resolveEmbeddingModel({ model: model.repository }, options);
    await downloadStarted;
    const second = resolveEmbeddingModel(
      { model: model.repository },
      { ...options, root: await createTemporaryDirectory() }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseDownload();

    const resolved = await Promise.all([first, second]);
    assert.equal(resolved[0].modelDir, resolved[1].modelDir);
    assert.equal(resolved[0].modelDir, path.join(home, '.cds', 'models', 'example', 'model'));
    assert.equal(warnings.length, 2);
    assert.equal(requestedUrls.length, model.files.length);
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
      /@cap-js\/ai install-model example\/model --directory \.\/models/
    );
    assert.equal(fetched, false);
  });

  test('resolves relative directories from cds.root and preserves absolute directories', async () => {
    const root = await createTemporaryDirectory();
    const content = Buffer.from('directory resolution fixture');
    const model = fixtureModel(content);
    const modelRoot = path.join(root, 'models');
    const modelDir = getModelDirectory(modelRoot, model.repository);
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    const relative = await resolveEmbeddingModel(
      { model: model.repository, directory: './models' },
      { root }
    );
    const absolute = await resolveEmbeddingModel(
      { model: model.repository, directory: modelRoot },
      { root: await createTemporaryDirectory() }
    );

    assert.equal(relative.modelDir, modelDir);
    assert.equal(absolute.modelDir, modelDir);
  });

  test('rejects a configured model name that does not match the provisioned lock', async () => {
    const modelRoot = await createTemporaryDirectory();
    const content = Buffer.from('repository mismatch fixture');
    const model = fixtureModel(content);
    const modelDir = getModelDirectory(modelRoot, 'example/other-model');
    await provisionModel(model, { directory: modelDir, fetchImpl: createFetch(content) });

    await assert.rejects(
      resolveEmbeddingModel({ model: 'example/other-model', directory: modelRoot }),
      /contains example\/model, not example\/other-model/
    );
  });

  test('gives models a model-name provisioning command', async () => {
    const root = await createTemporaryDirectory();

    await assert.rejects(
      resolveEmbeddingModel({ model: 'example/custom', directory: './models/custom' }, { root }),
      /@cap-js\/ai install-model example\/custom --directory \.\/models\/custom/
    );
  });

  test('requires explicit lock recovery before reinstalling', async () => {
    const modelRoot = await createTemporaryDirectory();
    const modelDir = getModelDirectory(modelRoot, 'example/model');
    await fs.mkdir(modelDir, { recursive: true });
    await fs.writeFile(path.join(modelDir, MODEL_LOCK_FILE), '{}');

    await assert.rejects(
      resolveEmbeddingModel({ model: 'example/model', directory: modelRoot }),
      /Remove or replace the invalid lock explicitly, then run 'npx @cap-js\/ai install-model/
    );
  });

  test('installs a model by name through the command API', async () => {
    const root = await createTemporaryDirectory();
    const modelRoot = path.join(root, 'models');
    const content = Buffer.from('command fixture');
    const model = fixtureModel(content);
    const output = [];

    await runModelCommand(['install-model', model.repository, '--directory', modelRoot], {
      root,
      discover: () => model,
      fetchImpl: createFetch(content),
      validate: async () => {},
      stdout: { write: (value) => output.push(value) }
    });

    const modelDir = getModelDirectory(modelRoot, model.repository);
    assert.deepEqual(await readModelLock(modelDir), model);
    assert.match(output.join(''), /Installed example\/model/);
    assert.match(output.join(''), new RegExp(escapeRegExp(modelDir)));
  });

  test('installs into the home model cache when no directory is provided', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const content = Buffer.from('default command fixture');
    const model = fixtureModel(content);

    await runModelCommand(['install-model', model.repository], {
      root,
      home,
      discover: () => model,
      fetchImpl: createFetch(content),
      validate: async () => {},
      stdout: { write() {} }
    });

    const modelDir = path.join(home, '.cds', 'models', 'example', 'model');
    assert.deepEqual(await readModelLock(modelDir), model);
    await assert.rejects(fs.access(path.join(root, '.cds', 'models')), /ENOENT/);
  });

  test('uses home by default and resolves relative command directories from the CAP project root', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const subdirectory = path.join(root, 'srv', 'nested');
    const content = Buffer.from('project root command fixture');
    const model = fixtureModel(content);
    const options = {
      cwd: subdirectory,
      home,
      discover: () => model,
      fetchImpl: createFetch(content),
      validate: async () => {},
      stdout: { write() {} }
    };
    await fs.mkdir(subdirectory, { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sap/cds': '^9' } })
    );

    await runModelCommand(['install-model', model.repository], options);
    assert.deepEqual(
      await readModelLock(path.join(home, '.cds', 'models', 'example', 'model')),
      model
    );

    await runModelCommand(
      ['install-model', model.repository, '--directory', './shared-models'],
      options
    );
    assert.deepEqual(
      await readModelLock(path.join(root, 'shared-models', 'example', 'model')),
      model
    );
  });

  test('checks a model by name without provisioning it', async () => {
    const root = await createTemporaryDirectory();
    const home = await createTemporaryDirectory();
    const output = [];
    const checked = {
      repository: 'example/model',
      revision: '1'.repeat(40),
      task: 'sentence-similarity',
      dimensions: 384,
      maxLength: 128,
      files: [
        { role: 'model', name: 'model.onnx', path: 'onnx/model.onnx' },
        { role: 'tokenizer', name: 'tokenizer.json', path: 'tokenizer.json' }
      ],
      output: {
        name: 'last_hidden_state',
        pooling: 'mean',
        normalize: true,
        includePrompt: true
      },
      prompts: { query: 'query: ', document: 'document: ' }
    };

    await runModelCommand(['check-model', checked.repository], {
      cwd: root,
      home,
      check: async (repository) => {
        assert.equal(repository, checked.repository);
        return checked;
      },
      stdout: { write: (value) => output.push(value) }
    });

    assert.match(output.join(''), /Likely compatible/i);
    assert.match(output.join(''), /Prompt tokens in pooling: included/);
    assert.match(output.join(''), /QUERY: "query: "/);
    assert.match(output.join(''), /DOCUMENT: "document: "/);
    assert.match(output.join(''), /install-model.*definitive/i);
    await assert.rejects(fs.access(path.join(root, '.cds', 'models')), /ENOENT/);
    await assert.rejects(fs.access(path.join(home, '.cds', 'models')), /ENOENT/);
  });

  test('requires a model name and accepts an optional cache root', async () => {
    await assert.rejects(
      runModelCommand(['install-model', '--directory', './models/custom']),
      /Specify a model name/
    );
    await assert.rejects(
      runModelCommand(['install-model', 'example/model', 'example/other']),
      /Unexpected argument 'example\/other'/
    );
    await assert.rejects(
      runModelCommand(['check-model', 'example/model', '--directory', './models']),
      /Unknown option '--directory'/
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

function fixtureModel(content, repository = 'example/model') {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    repository,
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
    output: {
      name: 'last_hidden_state',
      pooling: 'mean',
      normalize: true,
      includePrompt: true
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
