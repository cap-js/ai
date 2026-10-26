import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { formatModelCommandError, runModelCommand } from '../lib/vector_embedding/cli.js';
import { MODEL_INSPECTION_INCOMPLETE } from '../lib/vector_embedding/model-discovery.js';

const REPOSITORY = 'example/embedding-model';
const REVISION = '1'.repeat(40);

for (const directory of ['', 'exports/encoder/']) {
  for (const filename of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    test(`presents missing ${directory}${filename} according to its inspection role`, async () => {
      const stdout = capture();
      const modelPath = `${directory}model.onnx`;
      const hubClient = {
        getModelInfo: async () => ({ sha: REVISION, task: 'sentence-similarity' }),
        getFiles: async () =>
          ['model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json']
            .filter((name) => name !== filename)
            .map((name) => ({ path: `${directory}${name}` })),
        getFile: async () => assert.fail('missing companions require no artifact download')
      };
      let failure;
      await assert.rejects(
        runModelCommand(['check-model', REPOSITORY], { root: '/project', stdout, hubClient }),
        (error) => {
          failure = error;
          assert.equal(
            error.code,
            filename === 'config.json' ? MODEL_INSPECTION_INCOMPLETE : undefined
          );
          return true;
        }
      );
      assert.equal(stdout.text(), '');
      assert.equal(
        failure.message,
        `Hugging Face model '${REPOSITORY}' must contain '${filename}' at the repository root or next to '${modelPath}'`
      );

      const plain = formatModelCommandError(failure, { stderr: capture(), env: {} });
      const styled = formatModelCommandError(failure, { stderr: capture(true), env: {} });
      assert.equal(stripVTControlCharacters(styled), plain);
      assert.ok(plain.includes(failure.message));
      assert.doesNotMatch(plain, /Likely compatible|install-model/);
      if (filename === 'config.json') {
        assert.ok(styled.includes('\x1b[33m[ERROR] Inspection incomplete'));
        assert.equal(styled.includes('\x1b[31m'), false);
        assert.match(plain, /Compatibility is unknown; ONNX Runtime not validated\./);
        assert.deepEqual(failure.details, { repository: REPOSITORY, file: filename });
      } else {
        assert.ok(styled.includes('\x1b[31m[ERROR]'));
        assert.doesNotMatch(plain, /Inspection incomplete|Compatibility is unknown/);
      }
      for (const env of [{ NO_COLOR: '' }, { TERM: 'dumb' }]) {
        assert.equal(formatModelCommandError(failure, { stderr: capture(true), env }), plain);
      }
    });
  }
}

function capture(isTTY = false) {
  const chunks = [];
  return { isTTY, write: (chunk) => chunks.push(chunk), text: () => chunks.join('') };
}
