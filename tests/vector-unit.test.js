import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  createFeeds,
  createTokenizerState,
  poolOutput,
  tokenizeToWindow
} from '../lib/vector_embedding/embedding.js';
import {
  downloadFile,
  downloadModelIfNeeded,
  getModelDirectory,
  getModelRoot,
  loadTokenizerPackage,
  validateModelDescriptor
} from '../lib/vector_embedding/model-utils.js';
import { loadOnnxRuntime } from '../lib/vector_embedding/load-onnx-runtime.js';
import { loadSQLiteService } from '../lib/sqlite/load-sqlite.js';

const temporaryDirectories = [];

test('explains how to install the optional tokenizer peer dependency', async () => {
  const missing = Object.assign(
    new Error("Cannot find package '@huggingface/tokenizers' imported from model-utils.js"),
    { code: 'ERR_MODULE_NOT_FOUND' }
  );

  await assert.rejects(
    loadTokenizerPackage(async () => {
      throw missing;
    }),
    /npm add @huggingface\/tokenizers@0\.1\.3/
  );
});

test('explains how to install the optional SQLite peer dependency', () => {
  const missing = Object.assign(
    new Error("Cannot find module '@cap-js/sqlite' required by load-sqlite.js"),
    { code: 'MODULE_NOT_FOUND' }
  );

  assert.throws(
    () =>
      loadSQLiteService(() => {
        throw missing;
      }),
    /npm add -D @cap-js\/sqlite/
  );
});

test('explains how to install the pinned ONNX Runtime peer dependency', () => {
  const missing = Object.assign(new Error("Cannot find module 'onnxruntime-node/package.json'"), {
    code: 'MODULE_NOT_FOUND'
  });

  assert.throws(
    () =>
      loadOnnxRuntime(() => {
        throw missing;
      }),
    /npm add -D onnxruntime-node@1\.20\.1/
  );
});

test('does not mask unrelated optional-peer loading errors', () => {
  const sqliteError = Object.assign(new Error('SQLite native binding failed'), {
    code: 'ERR_DLOPEN_FAILED'
  });
  const runtimeError = Object.assign(new Error('ONNX native binding failed'), {
    code: 'ERR_DLOPEN_FAILED'
  });

  assert.throws(
    () =>
      loadSQLiteService(() => {
        throw sqliteError;
      }),
    sqliteError
  );
  assert.throws(
    () =>
      loadOnnxRuntime((specifier) => {
        if (specifier.endsWith('package.json')) return { version: '1.20.1' };
        throw runtimeError;
      }),
    runtimeError
  );
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('tokenizer input window', () => {
  const tokenizer = {
    encode(text, { add_special_tokens: addSpecialTokens }) {
      const ids = text
        .split(/\s+/u)
        .filter(Boolean)
        .map((_, index) => index + 10);
      const attention_mask = ids.map((_, index) => index % 2);
      const token_type_ids = ids.map((_, index) => index + 20);
      return addSpecialTokens
        ? {
            ids: [101, ...ids, 102],
            attention_mask: [1, ...attention_mask, 1],
            token_type_ids: [9, ...token_type_ids, 10]
          }
        : { ids, attention_mask, token_type_ids };
    }
  };

  test('derives special-token boundaries and keeps one complete model window', () => {
    const state = createTokenizerState(tokenizer, 5);
    const input = tokenizeToWindow('one two three four five six seven', tokenizer, state);

    assert.deepEqual(input.ids, [101, 10, 11, 12, 102]);
    assert.deepEqual(input.attention_mask, [1, 0, 1, 0, 1]);
    assert.deepEqual(input.token_type_ids, [9, 20, 21, 22, 10]);
  });

  test('truncates content without relying on tokenizer-side truncation', () => {
    const state = createTokenizerState(tokenizer, 4);
    const input = tokenizeToWindow(new Array(9).fill('token').join(' '), tokenizer, state);

    assert.deepEqual(input.ids, [101, 10, 11, 102]);
  });
});

describe('model compatibility', () => {
  test('filters standard int64 feeds by the model input names', () => {
    const feeds = createFeeds({
      ids: [101, 200, 102],
      attention_mask: [1, 0, 1],
      token_type_ids: [0, 1, 1]
    });

    assert.deepEqual(Object.keys(feeds), ['input_ids', 'attention_mask', 'token_type_ids']);
    assert.deepEqual(feeds.input_ids.dims, [1, 3]);
    assert.deepEqual(Array.from(feeds.input_ids.data), [101n, 200n, 102n]);
    assert.deepEqual(Array.from(feeds.attention_mask.data), [1n, 0n, 1n]);
    assert.deepEqual(Array.from(feeds.token_type_ids.data), [0n, 1n, 1n]);

    const filtered = createFeeds(
      {
        ids: [101],
        attention_mask: [1],
        token_type_ids: [0]
      },
      ['input_ids', 'attention_mask']
    );
    assert.deepEqual(Object.keys(filtered), ['input_ids', 'attention_mask']);
  });

  test('supports mean, CLS, and already-pooled outputs', () => {
    const sequence = {
      type: 'float32',
      data: new Float32Array([1, 2, 3, 4]),
      dims: [1, 2, 2]
    };
    const pooled = { type: 'float64', data: new Float64Array([5, 6]), dims: [1, 2] };

    assert.deepEqual(Array.from(poolOutput(sequence, 'mean')), [2, 3]);
    assert.deepEqual(Array.from(poolOutput(sequence, 'cls')), [1, 2]);
    assert.deepEqual(Array.from(poolOutput(pooled, 'none')), [5, 6]);
  });

  test('rejects non-floating-point model outputs', () => {
    assert.throws(
      () => poolOutput({ type: 'int64', data: new BigInt64Array([1n]), dims: [1] }, 'none'),
      /must be float32 or float64/
    );
  });

  test('requires immutable revisions, checksums, and traversal-safe paths', () => {
    const model = fixtureModel(Buffer.from('fixture'));
    assert.equal(validateModelDescriptor(model), model);

    assert.throws(
      () => validateModelDescriptor({ ...model, revision: 'main' }),
      /immutable 40-64 character commit hash/
    );
    assert.throws(
      () =>
        validateModelDescriptor({
          ...model,
          files: model.files.map((file, index) =>
            index === 0 ? { ...file, name: '../model.onnx' } : file
          )
        }),
      /safe relative path/
    );
    assert.throws(
      () =>
        validateModelDescriptor({
          ...model,
          files: model.files.map((file, index) =>
            index === 0 ? { ...file, name: 'embedding.lock.json' } : file
          )
        }),
      /conflicts with provisioning metadata/
    );
    assert.throws(
      () =>
        validateModelDescriptor({
          ...model,
          files: model.files.map((file, index) =>
            index === 0 ? { ...file, name: 'EMBEDDING.LOCK.JSON' } : file
          )
        }),
      /conflicts with provisioning metadata/
    );
    assert.throws(
      () =>
        validateModelDescriptor({
          ...model,
          files: model.files.map((file, index) => {
            if (index === 0) return { ...file, name: 'nested' };
            if (index === 1) return { ...file, name: 'nested/tokenizer.json' };
            return file;
          })
        }),
      /conflicts with another embedding file/
    );
  });
});

describe('model directories', () => {
  test('uses a project-local default and appends the model repository', () => {
    const project = path.join(path.sep, 'project');
    const root = getModelRoot(undefined, project);

    assert.equal(root, path.join(project, '.cds', 'models'));
    assert.equal(getModelDirectory(root, 'foo/bar'), path.join(root, 'foo', 'bar'));
  });

  test('resolves relative, absolute, and home-relative roots', () => {
    const project = path.join(path.sep, 'project');
    const home = path.join(path.sep, 'home', 'user');

    assert.equal(getModelRoot('./models', project, home), path.join(project, 'models'));
    assert.equal(
      getModelRoot(path.join(path.sep, 'shared', 'models'), project, home),
      path.join(path.sep, 'shared', 'models')
    );
    assert.equal(getModelRoot('~/.cds/models', project, home), path.join(home, '.cds', 'models'));
  });
});

describe('model download', () => {
  test('uses a pinned revision and atomically caches verified files', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('verified model fixture');
    const model = fixtureModel(content);
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(url);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(content.subarray(0, 5));
          controller.enqueue(content.subarray(5));
          controller.close();
        }
      });
      return new Response(body, {
        headers: { 'content-length': String(content.length) }
      });
    };

    await downloadModelIfNeeded(directory, model, { fetchImpl });
    await downloadModelIfNeeded(directory, model, { fetchImpl });

    assert.deepEqual(
      requestedUrls,
      model.files.map(
        (file) => `https://huggingface.co/example/model/resolve/${model.revision}/${file.path}`
      )
    );
    assert.deepEqual(await fs.readFile(path.join(directory, 'model.onnx')), content);
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      'model.onnx',
      'tokenizer.json',
      'tokenizer_config.json'
    ]);
  });

  test('authenticates model downloads and honors a custom Hub URL', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('authenticated model fixture');
    const model = fixtureModel(content);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push([url, options]);
      return new Response(content);
    };

    await downloadModelIfNeeded(directory, model, {
      fetchImpl,
      accessToken: 'secret',
      hubUrl: 'https://hub.example.test///'
    });

    assert.ok(
      requests.every(([url]) => url.startsWith('https://hub.example.test/example/model/resolve/'))
    );
    assert.ok(requests.every(([, options]) => options.headers.Authorization === 'Bearer secret'));
  });

  test('rejects oversized content without exposing a partial cache file', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('expected');
    const file = fixtureModel(content).files[0];
    const outputPath = path.join(directory, file.name);
    const fetchImpl = async () => new Response(Buffer.concat([content, Buffer.from('extra')]));

    await assert.rejects(
      downloadFile('https://example.test/model', outputPath, file, { fetchImpl }),
      /exceeds the expected 8 bytes/
    );
    assert.deepEqual(await fs.readdir(directory), []);
  });

  test('rejects content that does not match the pinned checksum', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('expected');
    const file = fixtureModel(content).files[0];
    const outputPath = path.join(directory, file.name);
    const fetchImpl = async () => new Response(Buffer.from('tampered'));

    await assert.rejects(
      downloadFile('https://example.test/model', outputPath, file, { fetchImpl }),
      /Invalid SHA-256/
    );
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

async function createTemporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-model-'));
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
