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
      assert.equal(typeof options.fetch, 'function');
      assert.equal(options.hubUrl, 'https://hub.example.test');
      assert.equal('accessToken' in options, false);
    }
    assert.deepEqual(calls[1][1].repo, { type: 'model', name: 'foo/bar' });
    assert.equal(calls[1][1].revision, '2'.repeat(40));
    assert.equal(calls[2][1].xet, false);
  });

  test('rejects unsafe Hub URLs', () => {
    const bindings = downloadBindings();
    assert.throws(
      () => createHuggingFaceClient({ hubUrl: 'http://hub.example.test', bindings }),
      /must use HTTPS/
    );
    assert.throws(
      () => createHuggingFaceClient({ hubUrl: 'https://user@hub.example.test', bindings }),
      /must not include credentials/
    );
    assert.throws(
      () => createHuggingFaceClient({ hubUrl: 'https://hub.example.test?mirror=1', bindings }),
      /must not include a query or fragment/
    );
  });

  test('matches the installed @huggingface/hub response contract', async () => {
    const revision = '1'.repeat(40);
    const contents = Buffer.from('{"hidden_size":384}');
    const requests = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      requests.push({ url, headers });

      if (url.includes('/api/models/foo/bar/revision/HEAD?')) {
        return Response.json({
          _id: 'model-id',
          id: 'foo/bar',
          private: false,
          pipeline_tag: 'sentence-similarity',
          downloads: 42,
          gated: false,
          likes: 7,
          lastModified: '2026-01-01T00:00:00.000Z',
          sha: revision,
          siblings: [{ rfilename: 'config.json' }]
        });
      }
      if (url.includes(`/api/models/foo/bar/tree/${revision}?`)) {
        return Response.json([
          { type: 'directory', path: 'onnx', size: 0 },
          {
            type: 'file',
            path: 'onnx/model.onnx',
            size: contents.length,
            lfs: { oid: '2'.repeat(64), size: contents.length, pointerSize: 128 }
          }
        ]);
      }
      if (url.endsWith(`/foo/bar/resolve/${revision}/config.json`)) {
        if (headers.get('range')) {
          return new Response(contents.subarray(0, 1), {
            status: 206,
            headers: {
              'content-range': `bytes 0-0/${contents.length}`,
              'content-type': 'application/json',
              etag: '"config"'
            }
          });
        }
        return new Response(contents, { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = createHuggingFaceClient({
      fetchImpl,
      hubUrl: 'https://hub.example.test',
      requestRetries: 0
    });

    const info = await client.getModelInfo('foo/bar');
    assert.equal(info.task, 'sentence-similarity');
    assert.equal(info.sha, revision);
    assert.deepEqual(await client.getFiles('foo/bar', revision), [
      {
        type: 'file',
        path: 'onnx/model.onnx',
        size: contents.length,
        lfs: { oid: '2'.repeat(64), size: contents.length, pointerSize: 128 }
      }
    ]);
    assert.deepEqual(await client.getFile('foo/bar', revision, 'config.json'), contents);
    assert.ok(requests.every(({ headers }) => !headers.has('authorization')));
  });

  test('retries transient Hub responses', async () => {
    let attempts = 0;
    const client = createHuggingFaceClient({
      fetchImpl: async () => {
        attempts++;
        return attempts === 1 ? new Response('unavailable', { status: 503 }) : Response.json({});
      },
      requestRetries: 1,
      requestRetryMs: 0,
      bindings: fetchOnlyBindings()
    });

    await client.getModelInfo('foo/bar');
    assert.equal(attempts, 2);
  });

  test('times out stalled Hub requests', async () => {
    const client = createHuggingFaceClient({
      fetchImpl: (input, { signal }) =>
        new Promise((resolve, reject) => {
          void input;
          void resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      requestRetries: 0,
      requestTimeoutMs: 10,
      bindings: fetchOnlyBindings()
    });

    await assert.rejects(client.getModelInfo('foo/bar'), /Timed out after 10 ms/);
  });

  test('does not retry non-transient Hub responses', async () => {
    let attempts = 0;
    const client = createHuggingFaceClient({
      fetchImpl: async () => {
        attempts++;
        return new Response('not found', { status: 404 });
      },
      requestRetries: 2,
      requestRetryMs: 0,
      bindings: fetchOnlyBindings()
    });

    await assert.rejects(client.getModelInfo('foo/bar'), /status 404/);
    assert.equal(attempts, 1);
  });

  test('rejects oversized Hub files from declared response metadata', async () => {
    const client = createHuggingFaceClient({
      fetchImpl: async () =>
        new Response('oversized', {
          headers: { 'content-length': '9' }
        }),
      requestRetries: 0,
      maxResponseBytes: 8,
      bindings: downloadBindings()
    });

    await assert.rejects(
      client.getFile('foo/bar', '1'.repeat(40), 'config.json'),
      /exceeds 8 bytes/
    );
  });

  test('rejects oversized Hub files from a range probe before downloading them', async () => {
    const client = createHuggingFaceClient({
      fetchImpl: async () =>
        new Response('x', {
          status: 206,
          headers: { 'content-length': '1', 'content-range': 'bytes 0-0/9' }
        }),
      requestRetries: 0,
      maxResponseBytes: 8,
      bindings: downloadBindings()
    });

    await assert.rejects(
      client.getFile('foo/bar', '1'.repeat(40), 'config.json'),
      /exceeds 8 bytes/
    );
  });

  test('rejects streamed Hub files that exceed the response limit', async () => {
    const client = createHuggingFaceClient({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('four'));
              controller.enqueue(Buffer.from('more'));
              controller.close();
            }
          })
        ),
      requestRetries: 0,
      maxResponseBytes: 4,
      bindings: downloadBindings()
    });

    await assert.rejects(
      client.getFile('foo/bar', '1'.repeat(40), 'config.json'),
      /exceeds 4 bytes/
    );
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
      /npm add -D @huggingface\/hub/
    );
  });
});

function fetchOnlyBindings() {
  return {
    async modelInfo({ fetch }) {
      const response = await fetch('https://hub.example.test/model');
      if (!response.ok) throw new Error(`status ${response.status}`);
      return {};
    },
    async *listFiles() {},
    async downloadFile() {}
  };
}

function downloadBindings() {
  return {
    async modelInfo() {},
    async *listFiles() {},
    async downloadFile({ fetch }) {
      return (await fetch('https://hub.example.test/file')).blob();
    }
  };
}
