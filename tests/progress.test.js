import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

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
  test('updates a single status line on a TTY', () => {
    const chunks = [];
    const stdout = { isTTY: true, write: (value) => chunks.push(value) };
    const report = createCliProgressReporter({ stdout });

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
    assert.match(out, /Downloading 2 file\(s\)/);
    assert.match(out, /\r/); // in-place updates use carriage return
    assert.match(out, /50%/);
    assert.match(out, /ETA/);
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
    assert.match(out, /Downloading 1 file\(s\).*1 already present/);
    assert.match(out, /skip tokenizer\.json/);
    assert.match(out, /done model\.onnx/);
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

    assert.match(lines[0], /Downloading embedding model: 2 file\(s\)/);
    assert.ok(lines.some((line) => /50%/.test(line)));
    assert.match(lines.at(-1), /download complete/);
  });

  test('requires a log function', () => {
    assert.throws(() => createLogProgressReporter({}), /requires a log function/);
  });
});
