import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createHuggingFaceClient,
  loadHuggingFaceHub
} from '../lib/vector_embedding/huggingface-hub.js';

describe('Hugging Face Hub adapter', () => {
  test('pins all operations and forwards custom transport options', async () => {
    const calls = [];
    const fetchImpl = () => {};
    const bindings = {
      async modelInfo(options) {
        calls.push(['modelInfo', options]);
        return { sha: '1'.repeat(40) };
      },
      async *listFiles(options) {
        calls.push(['listFiles', options]);
        yield { type: 'directory', path: 'onnx', size: 0 };
        yield { type: 'file', path: 'onnx/model.onnx', size: 42 };
      },
      async downloadFile(options) {
        calls.push(['downloadFile', options]);
        return new Blob(['contents']);
      }
    };
    const client = createHuggingFaceClient({
      fetchImpl,
      hubUrl: 'https://hub.example.test',
      bindings
    });

    assert.deepEqual(await client.getModelInfo('foo/bar'), { sha: '1'.repeat(40) });
    assert.deepEqual(await client.getFiles('foo/bar', '2'.repeat(40)), [
      { type: 'file', path: 'onnx/model.onnx', size: 42 }
    ]);
    assert.deepEqual(
      await client.getFile('foo/bar', '2'.repeat(40), 'config.json'),
      Buffer.from('contents')
    );

    for (const [, options] of calls) {
      assert.equal(options.fetch, fetchImpl);
      assert.equal(options.hubUrl, 'https://hub.example.test');
      assert.equal('accessToken' in options, false);
    }
    assert.deepEqual(calls[1][1].repo, { type: 'model', name: 'foo/bar' });
    assert.equal(calls[1][1].revision, '2'.repeat(40));
    assert.equal(calls[2][1].xet, false);
  });

  test('explains how to install the missing optional discovery peer', async () => {
    const missingHub = Object.assign(
      new Error("Cannot find package '@huggingface/hub' imported from huggingface-hub.js"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );
    await assert.rejects(
      loadHuggingFaceHub(async () => {
        throw missingHub;
      }),
      /npm add @huggingface\/hub/
    );
  });
});
