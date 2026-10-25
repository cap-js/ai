import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import {
  formatModelCheck,
  formatModelCommandError,
  runModelCommand
} from '../lib/vector_embedding/cli.js';
import {
  checkModel,
  MODEL_INSPECTION_INCOMPLETE,
  MODEL_TASK_UNSUPPORTED
} from '../lib/vector_embedding/model-discovery.js';

const model = {
  repository: 'example/model',
  revision: '1234567890abcdef'.repeat(2) + '12345678',
  task: 'sentence-similarity',
  dimensions: 384,
  maxLength: 256,
  files: [{ role: 'model', name: 'model.onnx', path: 'onnx/model.onnx', size: 100 }],
  output: { name: 'last_hidden_state', pooling: 'mean', normalize: true, includePrompt: true }
};

function capture(isTTY = false) {
  const chunks = [];
  return { isTTY, chunks, write: (chunk) => chunks.push(chunk), text: () => chunks.join('') };
}

function assertPlain(text) {
  assert.equal(text.includes('\x1b'), false);
  assert.equal(text.includes('\r'), false);
}

describe('check-model presentation', () => {
  test('groups all metadata, keeps the full revision, and states the runtime limits', () => {
    const stdout = capture();
    const text = formatModelCheck(model, { stdout, elapsedMs: 420 });
    assert.match(text, /^Likely compatible: example\/model\nmetadata inspected in 420ms\n/);
    assert.match(text, /\nModel\n\s+Task\s+sentence-similarity/);
    assert.ok(text.includes(model.revision));
    assert.match(text, /ONNX model\s+onnx\/model.onnx/);
    assert.match(text, /\nEmbedding\n\s+Dimensions\s+384/);
    assert.match(text, /Input limit\s+256 tokens/);
    assert.match(text, /Expected output\s+last_hidden_state/);
    assert.match(text, /Pooling\s+mean/);
    assert.match(text, /Normalization\s+enabled/);
    assert.match(text, /Prompt pooling\s+included/);
    assert.match(text, /\nPrompts\n\s+Query\s+none\n\s+Document\s+none/);
    assert.match(text, /Metadata only; no model weights downloaded\./);
    assert.match(text, /ONNX Runtime not validated\./);
    assert.match(
      text,
      /Next: install and validate with ONNX Runtime\nnpx @cap-js\/ai install-model example\/model\n$/
    );
    assertPlain(text);
  });

  test('renders absent task, missing prompts, and empty prompts without inventing values', () => {
    const text = formatModelCheck(
      {
        ...model,
        task: undefined,
        output: { ...model.output, normalize: false, includePrompt: false },
        prompts: { query: '' }
      },
      { stdout: capture() }
    );
    assert.match(text, /Task\s+not declared/);
    assert.match(text, /Normalization\s+disabled/);
    assert.match(text, /Prompt pooling\s+excluded/);
    assert.match(text, /Query\s+""/);
    assert.match(text, /Document\s+none/);
  });

  test('quotes prompts and escapes terminal controls in metadata', () => {
    const text = formatModelCheck(
      {
        ...model,
        output: { ...model.output, name: 'output\x1b[31m\r' },
        prompts: { query: 'query: \n"quote"\t', document: 'document: ' }
      },
      { stdout: capture() }
    );
    assert.ok(text.includes(JSON.stringify('query: \n"quote"\t')));
    assert.match(text, /Document\s+"document: "/);
    assertPlain(text);
  });

  test('uses sparse styling on a TTY, respecting NO_COLOR and TERM=dumb', () => {
    const plain = formatModelCheck(model, { stdout: capture(), elapsedMs: 420 });
    const styled = formatModelCheck(model, { stdout: capture(true), env: {}, elapsedMs: 420 });
    assert.ok(styled.includes('\x1b['));
    assert.equal(stripVTControlCharacters(styled), plain);
    for (const env of [{ NO_COLOR: '1' }, { NO_COLOR: '' }, { TERM: 'dumb' }]) {
      assert.equal(formatModelCheck(model, { stdout: capture(true), env, elapsedMs: 420 }), plain);
    }
  });

  test('the command returns the inspected candidate with timing, without provisioning', async () => {
    const stdout = capture();
    const result = await runModelCommand(['check-model', model.repository], {
      root: '/project',
      stdout,
      check: async (repository) => {
        assert.equal(repository, model.repository);
        return model;
      },
      install: () => assert.fail('inspection must not install')
    });
    assert.equal(result, model);
    assert.match(stdout.text(), /metadata inspected in \d+(?:\.\d+)?(?:ms|s)/);
  });
});

describe('install-model presentation', () => {
  test('announces identity and cache early, and marks success only after runtime validation', async () => {
    const stdout = capture();
    await runModelCommand(['install-model', model.repository], {
      root: '/project',
      home: '/home/test',
      stdout,
      install: async (repository, options) => {
        assert.equal(repository, model.repository);
        assert.match(
          stdout.text(),
          /^using embedding model example\/model\ncache \/home\/test\/\.cds\/models\/example\/model\n/
        );
        options.onProgress({ phase: 'plan', pendingFiles: 1, totalFiles: 1, totalBytes: 100 });
        options.onProgress({
          phase: 'done',
          downloadedBytes: 100,
          totalBytes: 100,
          elapsedMs: 420
        });
        assert.doesNotMatch(stdout.text(), /Installed|ready to use/);
        options.onProgress({ phase: 'validate:start' });
        assert.match(stdout.text(), /Download complete[\s\S]*Validating ONNX model/);
        options.onProgress({ phase: 'validate:done', elapsedMs: 1200, dimensions: 384 });
        assert.doesNotMatch(stdout.text(), /Installed|ready to use/);
        return { model, modelDir: '/home/test/.cds/models/example/model' };
      }
    });
    assert.match(
      stdout.text(),
      /Installed example\/model \(384 dimensions\)\nvalidated in 1\.2s · ready to use\ncache \/home\/test\/\.cds\/models\/example\/model\n$/
    );
    assertPlain(stdout.text());
    assert.match(stdout.chunks.at(-1), /^Installed[\s\S]*cache .*\n$/);
  });

  test('resolves relative cache paths from the CAP root before installation begins', async () => {
    const stdout = capture();
    await runModelCommand(['install-model', model.repository, '--directory', './models'], {
      root: '/project',
      stdout,
      install: async () => {
        assert.match(stdout.text(), /cache \/project\/models\/example\/model/);
        return { model, modelDir: '/project/models/example/model' };
      }
    });
  });

  test('styles only TTY success and identity, with plain output when colors are disabled', async () => {
    const run = async (stdout, env) => {
      await runModelCommand(['install-model', model.repository, '--directory', '/cache'], {
        root: '/project',
        stdout,
        env,
        install: async (_repository, options) => {
          options.onProgress({ phase: 'validate:start' });
          options.onProgress({ phase: 'validate:done', elapsedMs: 1200, dimensions: 384 });
          return { model, modelDir: '/cache/example/model' };
        }
      });
      return stdout.text();
    };
    const plain = await run(capture(), {});
    const styled = await run(capture(true), {});
    assert.ok(styled.includes('\x1b[32mInstalled'));
    assert.ok(styled.includes('\x1b[1mexample/model'));
    assert.equal(stripVTControlCharacters(styled), plain);
    await Promise.all(
      [{ NO_COLOR: '' }, { NO_COLOR: '1' }, { TERM: 'dumb' }].map(async (env) => {
        assert.equal(await run(capture(true), env), plain);
      })
    );
  });

  test('cached models still validate and do not claim another download', async () => {
    const stdout = capture();
    await runModelCommand(['install-model', model.repository], {
      root: '/project',
      stdout,
      install: async (_repository, options) => {
        options.onProgress({ phase: 'plan', pendingFiles: 0, totalFiles: 1, totalBytes: 0 });
        options.onProgress({ phase: 'done', totalBytes: 0, downloadedBytes: 0, elapsedMs: 0 });
        options.onProgress({ phase: 'validate:start' });
        options.onProgress({ phase: 'validate:done', elapsedMs: 420, dimensions: 384 });
        return { model, modelDir: '/cache/example/model' };
      }
    });
    assert.match(stdout.text(), /already downloaded/);
    assert.match(stdout.text(), /Validating ONNX model[\s\S]*Installed example\/model/);
    assert.match(stdout.text(), /validated in 420ms/);
    assert.doesNotMatch(stdout.text(), /Download complete/);
  });

  test('cleans up a live transfer before propagating the original validation failure', async () => {
    const stdout = capture(true);
    const failure = new Error('ONNX output dimensions do not match');
    await assert.rejects(
      runModelCommand(['install-model', model.repository], {
        root: '/project',
        stdout,
        env: {},
        install: async (_repository, options) => {
          options.onProgress({
            phase: 'progress',
            name: 'model.onnx',
            totalBytes: 100,
            downloadedBytes: 50,
            elapsedMs: 1000
          });
          throw failure;
        }
      }),
      (error) => error === failure
    );
    assert.doesNotMatch(stdout.text(), /Installed|ready to use/);
    assert.ok(stdout.text().endsWith('\r\x1b[K'));
  });

  test('forwards a custom progress callback unchanged and writes nothing on failure', async () => {
    const stdout = capture();
    const event = { phase: 'validate:start' };
    const onProgress = (received) => {
      assert.equal(received, event);
      return 'callback result';
    };
    const failure = new Error('custom installation failed');
    await assert.rejects(
      runModelCommand(['install-model', model.repository], {
        root: '/project',
        stdout,
        onProgress,
        install: async (_repository, options) => {
          assert.equal(options.onProgress, onProgress);
          assert.equal(options.onProgress(event), 'callback result');
          throw failure;
        }
      }),
      (error) => error === failure
    );
    assert.equal(stdout.text(), '');
  });
});

describe('model command errors', () => {
  test('reports a definite unsupported task in red with an embedding-model action', async () => {
    const error = await inspectionFailure({ task: 'text-generation' });
    assert.equal(error.code, MODEL_TASK_UNSUPPORTED);
    assert.deepEqual(error.details, { repository: model.repository, task: 'text-generation' });
    const text = formatModelCommandError(error, { stderr: capture(true), env: {} });
    assert.ok(text.includes('\x1b[31m'));
    assert.match(text, /Unsupported embedding task/);
    assert.ok(text.includes(error.message));
    assert.match(text, /sentence-similarity, feature-extraction/);
    assert.match(text, /Choose a model intended for embeddings/);
    assert.match(text, /Installing will not bypass this check/);
    assert.doesNotMatch(text, /install-model/);
  });

  test('distinguishes missing metadata with an amber incomplete error and preserves the cause', async () => {
    const error = await inspectionFailure({ dimensions: undefined });
    assert.equal(error.code, MODEL_INSPECTION_INCOMPLETE);
    assert.deepEqual(error.details, { repository: model.repository, file: 'config.json' });
    assert.match(error.message, /Cannot determine embedding dimensions/);
    const stdout = capture();
    await assert.rejects(
      runModelCommand(['check-model', model.repository], {
        root: '/project',
        stdout,
        check: async () => {
          throw error;
        }
      }),
      (received) => received === error
    );
    assert.equal(stdout.text(), '');
    const text = formatModelCommandError(error, { stderr: capture(true), env: {} });
    assert.ok(text.includes('\x1b[33m'));
    assert.match(text, /\[ERROR\] Inspection incomplete/);
    assert.ok(text.includes(error.message));
    assert.match(text, /hidden_size, n_embd, d_model, or dim/);
    assert.doesNotMatch(text, /Likely compatible|install-model/);
  });

  test('does not classify errors from their message text, and keeps piped errors plain', () => {
    const failure = new Error('Cannot determine dimensions: connection failed\x1b[31m\r');
    const text = formatModelCommandError(failure, { stderr: capture(), env: {} });
    assert.match(text, /^\[ERROR\] Cannot determine dimensions: connection failed/);
    assert.doesNotMatch(text, /Inspection incomplete/);
    assertPlain(text);
    const styled = formatModelCommandError(failure, { stderr: capture(true), env: {} });
    assert.ok(styled.includes('\x1b[31m'));
    assert.equal(stripVTControlCharacters(styled), text);
    for (const env of [{ NO_COLOR: '' }, { TERM: 'dumb' }]) {
      assert.equal(formatModelCommandError(failure, { stderr: capture(true), env }), text);
    }
  });

  test('the executable reports an error on stderr and exits nonzero', () => {
    const result = spawnSync(
      process.execPath,
      [new URL('../bin/cds-ai.js', import.meta.url).pathname, 'unknown-command'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\[ERROR\] Unsupported command/);
    assertPlain(result.stderr);
  });
});

describe('bidi-safe presentation', () => {
  for (const [name, isTTY, env] of [
    ['plain', false, {}],
    ['TTY', true, {}],
    ['NO_COLOR', true, { NO_COLOR: '' }],
    ['dumb terminal', true, { TERM: 'dumb' }]
  ]) {
    test(`escapes prompt and error bidi controls in ${name} output without changing prompts`, async () => {
      const query = 'query: \u202eمَرْحَبًا\u202c';
      const document = 'document: \u2066日本語\u2069';
      const candidate = { ...model, prompts: { query, document } };
      const stdout = capture(isTTY);
      const checked = await runModelCommand(['check-model', model.repository], {
        root: '/project',
        stdout,
        env,
        check: async () => candidate
      });
      const text = stripVTControlCharacters(stdout.text());
      assert.doesNotMatch(text, /\p{Bidi_Control}/u);
      assert.ok(text.includes('"query: \\u202eمَرْحَبًا\\u202c"'));
      assert.ok(text.includes('"document: \\u2066日本語\\u2069"'));
      assert.equal(checked, candidate);
      assert.deepEqual(checked.prompts, { query, document });

      for (const code of [undefined, MODEL_TASK_UNSUPPORTED, MODEL_INSPECTION_INCOMPLETE]) {
        const failure = Object.assign(new Error('metadata \u202e日本語\u202c'), { code });
        const formatted = formatModelCommandError(failure, { stderr: capture(isTTY), env });
        assert.doesNotMatch(formatted, /\p{Bidi_Control}/u);
        assert.ok(formatted.includes('metadata \\u202e日本語\\u202c'));
        assert.equal(failure.message, 'metadata \u202e日本語\u202c');
      }
    });
  }
});

async function inspectionFailure(options = {}) {
  const { task = 'sentence-similarity' } = options;
  const dimensions = Object.hasOwn(options, 'dimensions') ? options.dimensions : 384;
  const hubClient = {
    getModelInfo: async () => ({ sha: model.revision, task }),
    getFiles: async () =>
      ['model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'].map((path) => ({
        path
      })),
    getFile: async (_repository, _revision, remotePath) => {
      assert.notEqual(remotePath, 'model.onnx', 'metadata inspection must not download weights');
      return Buffer.from(
        JSON.stringify(remotePath === 'config.json' ? { hidden_size: dimensions } : {})
      );
    }
  };
  try {
    await checkModel(model.repository, { hubClient });
    assert.fail('fixture must fail inspection');
  } catch (error) {
    return error;
  }
}
