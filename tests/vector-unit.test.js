import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { wordPieceTokenizer } from '../lib/vector_embedding/embedding.js';
import { downloadModelIfNeeded } from '../lib/vector_embedding/model-utils.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('BERT tokenizer', () => {
  const tokenizer = {
    maxLength: 128,
    normalizer: {
      clean_text: true,
      handle_chinese_chars: true,
      lowercase: true,
      strip_accents: null
    },
    vocab: new Map([
      ['[UNK]', 100],
      ['[CLS]', 101],
      ['[SEP]', 102],
      ['hello', 200],
      [',', 201],
      ['cafe', 202],
      ['中', 203],
      ['文', 204],
      ['token', 205]
    ])
  };

  test('applies BERT accent, punctuation, and Chinese character normalization', () => {
    const chunk = wordPieceTokenizer('Héllo, café中文', tokenizer);

    assert.deepEqual(chunk.tokens, ['[CLS]', 'hello', ',', 'cafe', '中', '文', '[SEP]']);
    assert.deepEqual(chunk.ids, [101, 200, 201, 202, 203, 204, 102]);
  });

  test('truncates input to one model window without an off-by-one', () => {
    const firstWindow = wordPieceTokenizer(new Array(126).fill('token').join(' '), tokenizer);
    const longInput = wordPieceTokenizer(new Array(130).fill('token').join(' '), tokenizer);

    assert.equal(longInput.ids.length, tokenizer.maxLength);
    assert.deepEqual(longInput.ids, [101, ...new Array(126).fill(205), 102]);
    assert.deepEqual(longInput, firstWindow);
  });
});

describe('model download', () => {
  test('uses a pinned revision and atomically caches a verified file', async () => {
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

    assert.deepEqual(requestedUrls, [
      'https://huggingface.co/example/model/resolve/deadbeef/model.onnx'
    ]);
    assert.deepEqual(await fs.readFile(path.join(directory, 'model.onnx')), content);
    assert.deepEqual(await fs.readdir(directory), ['model.onnx']);
  });

  test('rejects oversized content without exposing a partial cache file', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('expected');
    const model = fixtureModel(content);
    const fetchImpl = async () => new Response(Buffer.concat([content, Buffer.from('extra')]));

    await assert.rejects(
      downloadModelIfNeeded(directory, model, { fetchImpl }),
      /exceeds the expected 8 bytes/
    );
    assert.deepEqual(await fs.readdir(directory), []);
  });

  test('rejects content that does not match the pinned checksum', async () => {
    const directory = await createTemporaryDirectory();
    const content = Buffer.from('expected');
    const model = fixtureModel(content);
    const fetchImpl = async () => new Response(Buffer.from('tampered'));

    await assert.rejects(downloadModelIfNeeded(directory, model, { fetchImpl }), /Invalid SHA-256/);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

async function createTemporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-model-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureModel(content) {
  return {
    repository: 'example/model',
    revision: 'deadbeef',
    files: [
      {
        name: 'model.onnx',
        path: 'model.onnx',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex')
      }
    ]
  };
}
