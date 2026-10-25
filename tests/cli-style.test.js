import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createCliStyle, displayText, formatElapsed } from '../lib/vector_embedding/cli-style.js';

describe('CLI style', () => {
  test('uses terminal palette colors and sparse emphasis', () => {
    const style = createCliStyle({ isTTY: true }, {});
    assert.equal(style.enabled, true);
    for (const name of ['bold', 'dim', 'success', 'warning', 'error']) {
      assert.ok(style[name]('text').includes('\x1b['));
      assert.equal(stripVTControlCharacters(style[name]('text')), 'text');
    }
    assert.equal(style.success('Likely compatible'), '\x1b[32mLikely compatible\x1b[39m');
  });

  test('piped output stays plain even when colors are forced by the environment', () => {
    for (const env of [{}, { FORCE_COLOR: '1' }, { GITHUB_ACTIONS: '1' }]) {
      const style = createCliStyle({ isTTY: false }, env);
      assert.equal(style.enabled, false);
      for (const name of ['bold', 'dim', 'success', 'warning', 'error']) {
        assert.equal(style[name]('text'), 'text');
      }
    }
  });

  test('NO_COLOR takes precedence and dumb terminals remain plain', () => {
    for (const env of [{ NO_COLOR: '' }, { NO_COLOR: '1', FORCE_COLOR: '1' }, { TERM: 'dumb' }]) {
      assert.equal(createCliStyle({ isTTY: true }, env).success('text'), 'text');
    }
  });

  test('displays untrusted control characters without executing them', () => {
    assert.equal(
      displayText('path\n\r\t\x1b[31m\x7f\x9b'),
      'path\\u000a\\u000d\\u0009\\u001b[31m\\u007f\\u009b'
    );
    assert.equal(displayText('ordinary path/384'), 'ordinary path/384');
  });

  test('renders inspection and validation timings with suitable precision', () => {
    for (const [input, output] of [
      [0, '0ms'],
      [420, '420ms'],
      [1200, '1.2s'],
      [65000, '1m 05s'],
      [-1, '?'],
      [NaN, '?']
    ]) {
      assert.equal(formatElapsed(input), output);
    }
  });

  test('escapes all Unicode bidi controls without changing ordinary multilingual text', () => {
    const controls = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    assert.equal(
      displayText(controls),
      '\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069'
    );
    assert.equal(displayText('مَرْحَبًا 日本語 café 👋'), 'مَرْحَبًا 日本語 café 👋');
    assert.equal(displayText('literal \\u202e'), 'literal \\u202e');
  });
});
