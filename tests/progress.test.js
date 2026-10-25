import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { runModelCommand } from '../lib/vector_embedding/cli.js';
import {
  createCliProgressReporter,
  createLogProgressReporter,
  formatBytes,
  formatDuration,
  formatRate,
  overallPercent
} from '../lib/vector_embedding/progress.js';

describe('progress formatters', () => {
  test('formatBytes scales through units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(-1), '?');
  });

  test('formatDuration renders seconds and minutes', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(65000), '1m 05s');
    assert.equal(formatDuration(-1), '?');
  });

  test('formatRate appends a per-second suffix', () => {
    assert.equal(formatRate(1024), '1.0 KB/s');
    assert.equal(formatRate(0), '?');
  });

  test('overallPercent clamps and guards a zero total', () => {
    assert.equal(overallPercent(5, 10), 50);
    assert.equal(overallPercent(20, 10), 100);
    assert.equal(overallPercent(1, 0), undefined);
  });
});

describe('CLI progress reporter', () => {
  test('closing clears an open TTY line only once', () => {
    const chunks = [];
    const report = createCliProgressReporter({
      env: {},
      stdout: { isTTY: true, write: (value) => chunks.push(value) }
    });

    report.close();
    assert.deepEqual(chunks, []);
    report({
      phase: 'progress',
      name: 'model.onnx',
      downloadedBytes: 512,
      totalBytes: 1024,
      elapsedMs: 1000
    });
    report.close();
    report.close();
    report({ phase: 'done' });

    assert.equal(chunks.length, 2);
    assert.equal(chunks[1], '\r\x1b[K');
  });

  test('updates a single status line on a TTY', () => {
    const chunks = [];
    const stdout = { isTTY: true, write: (value) => chunks.push(value) };
    const report = createCliProgressReporter({ stdout, env: {} });

    report({ phase: 'plan', totalFiles: 2, pendingFiles: 2, skippedFiles: 0, totalBytes: 2048 });
    report({
      phase: 'progress',
      name: 'onnx/model.onnx',
      downloadedBytes: 1024,
      totalBytes: 2048,
      elapsedMs: 1000
    });
    report({ phase: 'done', totalBytes: 2048, elapsedMs: 2000 });

    const out = chunks.join('');
    assert.match(out, /Downloading 2 files/);
    assert.match(out, /\r/); // in-place updates use carriage return
    assert.match(out, /50%/);
    assert.match(out, /ETA/);
    assert.match(out, /\[##########\.{10}\]/);
    assert.match(out, /Download complete/);
    assert.ok(out.includes('\x1b[K')); // clears the transient line at the end
  });

  test('emits plain milestone lines without a TTY', () => {
    const lines = [];
    const stdout = { isTTY: false, write: (value) => lines.push(value) };
    const report = createCliProgressReporter({ stdout });

    report({ phase: 'plan', totalFiles: 2, pendingFiles: 1, skippedFiles: 1, totalBytes: 1024 });
    report({ phase: 'file:skip', name: 'tokenizer.json', size: 10 });
    report({
      phase: 'progress',
      name: 'model.onnx',
      downloadedBytes: 512,
      totalBytes: 1024,
      elapsedMs: 1000
    });
    report({ phase: 'file:done', name: 'model.onnx', size: 1024 });
    report({ phase: 'done', totalBytes: 1024, elapsedMs: 1500 });

    const out = lines.join('');
    assert.doesNotMatch(out, /\r/); // no control codes when piped
    assert.match(out, /Downloading 1 file.*1 already present/);
    assert.match(out, /Download complete/);
    assert.ok(!out.includes('\x1b'));
    assert.doesNotMatch(out, /skip tokenizer|done model/);
    assert.equal(lines.length, 2);
  });

  test('the ASCII bar grows with transferred bytes', (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => (now += 101));
    const chunks = [];
    const report = createCliProgressReporter({
      env: {},
      stdout: { isTTY: true, columns: 120, write: (value) => chunks.push(value) }
    });
    for (const downloadedBytes of [256, 512, 1024]) {
      report({ phase: 'progress', downloadedBytes, totalBytes: 1024, elapsedMs: 1000 });
    }
    assert.match(chunks[0], /\[#{5}\.{15}\].*25%/);
    assert.match(chunks[1], /\[#{10}\.{10}\].*50%/);
    assert.match(chunks[2], /\[#{20}\].*100%/);
  });

  for (const columns of [1, 20, 40, 80, 120]) {
    test(`a live status never wraps in a ${columns}-column terminal`, () => {
      const chunks = [];
      const report = createCliProgressReporter({
        env: {},
        stdout: { isTTY: true, columns, write: (value) => chunks.push(value) }
      });
      report({
        phase: 'progress',
        name: 'onnx/a-very-long-model-filename.onnx',
        downloadedBytes: 39 * 1024 * 1024,
        totalBytes: 76 * 1024 * 1024,
        elapsedMs: 19_000
      });
      const visible = stripVTControlCharacters(chunks[0]).replace(/\r/g, '');
      assert.ok(visible.length <= Math.max(1, columns - 1), visible);
      assert.doesNotMatch(visible, /\n/);
    });
  }

  test('NO_COLOR retains the bar but disables color and emphasis', () => {
    const chunks = [];
    const report = createCliProgressReporter({
      env: { NO_COLOR: '' },
      stdout: { isTTY: true, write: (value) => chunks.push(value) }
    });
    report({
      phase: 'progress',
      name: 'model.onnx',
      downloadedBytes: 512,
      totalBytes: 1024,
      elapsedMs: 1000
    });
    assert.match(chunks[0], /\[#{10}\.{10}\]/);
    assert.ok(!chunks[0].includes('\x1b[2m'));
  });

  test('a dumb terminal uses only plain milestones', () => {
    const chunks = [];
    const report = createCliProgressReporter({
      env: { TERM: 'dumb' },
      stdout: { isTTY: true, write: (value) => chunks.push(value) }
    });
    report({ phase: 'plan', pendingFiles: 1, totalFiles: 1, totalBytes: 1024 });
    report({ phase: 'progress', downloadedBytes: 512, totalBytes: 1024, elapsedMs: 1000 });
    report({ phase: 'done', totalBytes: 1024, elapsedMs: 2000 });
    assert.equal(chunks.length, 2);
    assert.doesNotMatch(chunks.join(''), /\r/);
    assert.ok(!chunks.join('').includes('\x1b'));
  });

  test('cached files and shared-cache waiting do not claim download completion', () => {
    const chunks = [];
    const report = createCliProgressReporter({ stdout: { write: (value) => chunks.push(value) } });
    report({ phase: 'waiting' });
    report({ phase: 'waiting' });
    report({ phase: 'plan', totalFiles: 1, pendingFiles: 0, totalBytes: 0 });
    report({ phase: 'done', totalBytes: 0, elapsedMs: 0 });
    report({ phase: 'validate:start' });
    assert.deepEqual(chunks, [
      'Waiting for another model installation\n',
      'Reusing 1 file already downloaded.\n',
      'Validating ONNX model\n'
    ]);
  });

  test('unknown transfer size does not invent a bar, percentage, or ETA', () => {
    const chunks = [];
    const report = createCliProgressReporter({
      env: {},
      stdout: { isTTY: true, write: (value) => chunks.push(value) }
    });
    report({ phase: 'progress', downloadedBytes: 512, elapsedMs: 1000 });
    assert.match(chunks[0], /512 B/);
    assert.doesNotMatch(stripVTControlCharacters(chunks[0]), /%|ETA|\[|NaN|Infinity/);
  });
});

describe('CLI progress cleanup', () => {
  const progress = {
    phase: 'progress',
    name: 'model.onnx',
    downloadedBytes: 512,
    totalBytes: 1024,
    elapsedMs: 1000
  };

  for (const isTTY of [true, false]) {
    test(`cleans up before reporting an installation failure (TTY: ${isTTY})`, async () => {
      const chunks = [];
      const stdout = { isTTY, write: (value) => chunks.push(value) };
      const stderr = { write: (value) => chunks.push(value) };
      const failure = new Error('Download failed');

      await assert.rejects(
        runModelCommand(['install-model', 'example/model'], {
          env: {},
          root: '/project',
          stdout,
          install: async (_model, { onProgress }) => {
            onProgress({ phase: 'plan', totalFiles: 1, pendingFiles: 1, totalBytes: 1024 });
            onProgress(progress);
            throw failure;
          }
        }),
        (error) => error === failure
      );
      stderr.write(`${failure.message}\n`);

      const output = chunks.join('');
      assert.doesNotMatch(output, /Installed/);
      if (isTTY) {
        assert.match(output, /50%/);
        assert.equal(chunks.at(-2), '\r\x1b[K');
        assert.ok(output.endsWith('\r\x1b[KDownload failed\n'));
      } else {
        assert.doesNotMatch(output, /\r/);
        assert.ok(!output.includes('\x1b'));
        assert.ok(output.endsWith('\nDownload failed\n'));
      }
    });

    test(`cleans up before the success message without a done event (TTY: ${isTTY})`, async () => {
      const chunks = [];
      await runModelCommand(['install-model', 'example/model'], {
        env: {},
        root: '/project',
        stdout: { isTTY, write: (value) => chunks.push(value) },
        install: async (_model, { onProgress }) => {
          onProgress(progress);
          return { modelDir: '/project/model' };
        }
      });

      if (isTTY) {
        assert.equal(chunks.at(-2), '\r\x1b[K');
      } else {
        assert.doesNotMatch(chunks.join(''), /\r/);
        assert.ok(!chunks.join('').includes('\x1b'));
      }
      assert.equal(
        stripVTControlCharacters(chunks.at(-1)),
        'Installed example/model\ncache /project/model\n'
      );
    });
  }

  test('a terminal cleanup write failure does not replace the installation failure', async () => {
    const failure = new Error('Download failed');
    await assert.rejects(
      runModelCommand(['install-model', 'example/model'], {
        env: {},
        root: '/project',
        stdout: {
          isTTY: true,
          write: (value) => {
            if (value === '\r\x1b[K') throw new Error('Terminal closed');
          }
        },
        install: async (_model, { onProgress }) => {
          onProgress(progress);
          throw failure;
        }
      }),
      (error) => error === failure
    );
  });

  test('custom callbacks receive only installer events and keep their own lifecycle', async () => {
    const events = [];
    const failure = new Error('Download failed');
    const onProgress = (event) => events.push(event);
    onProgress.close = () => assert.fail('A custom reporter owns its cleanup');

    await assert.rejects(
      runModelCommand(['install-model', 'example/model'], {
        root: '/project',
        stdout: { isTTY: true, write: () => assert.fail('Custom reporter emits no CLI progress') },
        onProgress,
        install: async (_model, options) => {
          assert.equal(options.onProgress, onProgress);
          options.onProgress(progress);
          throw failure;
        }
      }),
      (error) => error === failure
    );
    assert.deepEqual(events, [progress]);
  });
});

describe('log progress reporter', () => {
  test('logs a plan, throttled progress, and completion', () => {
    const lines = [];
    const report = createLogProgressReporter({
      log: (message) => lines.push(message),
      throttleMs: 0
    });

    report({ phase: 'plan', totalFiles: 2, pendingFiles: 2, skippedFiles: 0, totalBytes: 4096 });
    report({
      phase: 'progress',
      name: 'model.onnx',
      downloadedBytes: 2048,
      totalBytes: 4096,
      elapsedMs: 1000
    });
    report({ phase: 'done', totalBytes: 4096, elapsedMs: 2000 });

    assert.match(lines[0], /Downloading embedding model: 2 files/);
    assert.ok(lines.some((line) => /50%/.test(line)));
    assert.match(lines.at(-1), /download complete/);
    assert.doesNotMatch(lines.join('\n'), /\r/);
    assert.ok(!lines.join('\n').includes('\x1b'));
  });

  test('logs validation separately from download completion and stays plain', () => {
    const lines = [];
    const report = createLogProgressReporter({ log: (message) => lines.push(message) });
    report({ phase: 'done', totalBytes: 0, elapsedMs: 0 });
    report({ phase: 'waiting' });
    report({ phase: 'validate:start' });
    report({ phase: 'validate:done', dimensions: 384, elapsedMs: 1200 });
    assert.deepEqual(lines, [
      'Waiting for another embedding model installation.',
      'Validating embedding model.',
      'Embedding model validated (384 dimensions in 1.2s).'
    ]);
    assert.doesNotMatch(lines.join('\n'), /\r/);
    assert.ok(!lines.join('\n').includes('\x1b'));
  });

  test('requires a log function', () => {
    assert.throws(() => createLogProgressReporter({}), /requires a log function/);
  });
});
