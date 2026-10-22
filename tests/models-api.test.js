import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

const temporaryDirectories = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('public model provisioning API', () => {
  test('imports without registering CAP plugin hooks or loading inference dependencies', () => {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const api = await import('@cap-js/ai/models.js');
      assert.deepEqual(Object.keys(api), ['installModel']);
      assert.equal(typeof api.installModel, 'function');
      assert.deepEqual(Object.keys(require.cache).filter(file =>
        /[\\\\/](@sap[\\\\/]cds|onnxruntime-node|@huggingface[\\\\/]tokenizers)[\\\\/]/.test(file)), []);
    `
      ],
      { cwd: new URL('..', import.meta.url), stdio: 'pipe' }
    );
  });

  test('preserves the plugin entrypoint and existing deep package paths', () => {
    const packageRoot = path.dirname(require.resolve('@cap-js/ai/package.json'));
    assert.equal(require.resolve('@cap-js/ai'), path.join(packageRoot, 'cds-plugin.js'));
    for (const subpath of [
      'cds-plugin.js',
      'lib/sqlite/AISQLiteService.js',
      'lib/vector_embedding/model-install.js',
      'srv/MockAICoreService.cds'
    ]) {
      assert.equal(require.resolve(`@cap-js/ai/${subpath}`), path.join(packageRoot, subpath));
    }
    for (const subpath of [
      'cds-plugin',
      'lib/sqlite/AISQLiteService',
      'lib/vector_embedding/model-install',
      'srv/MockAICoreService'
    ]) {
      assert.equal(
        require.resolve(`@cap-js/ai/${subpath}`),
        path.join(packageRoot, `${subpath}.js`)
      );
    }
    assert.equal(require.resolve('@cap-js/ai/lib/mtx'), path.join(packageRoot, 'lib/mtx/index.js'));
  });

  test('provisions through the public entrypoint and returns reusable installation paths', async () => {
    const { installModel } = await import('@cap-js/ai/models.js');
    const { createHash } = await import('node:crypto');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-model-api-'));
    temporaryDirectories.push(root);
    const content = Buffer.from('public model provisioning fixture');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const model = {
      repository: 'example/public-model',
      revision: '1'.repeat(40),
      dimensions: 2,
      maxLength: 8,
      files: ['model', 'tokenizer', 'tokenizerConfig'].map((role) => ({
        role,
        name: `${role}.bin`,
        path: `${role}.bin`,
        size: content.length,
        sha256
      })),
      output: { name: 'last_hidden_state', pooling: 'mean', normalize: true, includePrompt: true }
    };
    let validations = 0;
    const result = await installModel(model.repository, {
      directory: './models',
      root,
      discover: () => model,
      fetchImpl: async () => new Response(content),
      validate: async () => {
        validations++;
      }
    });
    assert.deepEqual(result.model, model);
    assert.equal(result.modelRoot, path.join(root, 'models'));
    assert.equal(result.modelDir, path.join(root, 'models', 'example', 'public-model'));
    assert.equal(validations, 1);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(result.modelDir, 'embedding.lock.json'))).repository,
      model.repository
    );
  });
});
