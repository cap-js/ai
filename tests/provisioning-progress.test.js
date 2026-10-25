import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { installModel } from '../lib/vector_embedding/model-install.js';

const content = Buffer.from('synthetic lifecycle fixture');
const model = {
  repository: 'example/lifecycle',
  revision: '1'.repeat(40),
  dimensions: 384,
  maxLength: 256,
  files: ['model', 'tokenizer', 'tokenizerConfig'].map((role, index) => ({
    role,
    name: ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'][index],
    path: ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'][index],
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  })),
  output: { name: 'last_hidden_state', pooling: 'mean', normalize: true, includePrompt: true }
};

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-progress-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, discover: () => model, fetchImpl: async () => new Response(content) };
}

test('validation lifecycle follows transfer and is also emitted for cached models', async (t) => {
  const options = await setup(t);
  let fetches = 0;
  let validations = 0;
  const events = [];
  const installOptions = {
    ...options,
    fetchImpl: async () => {
      fetches++;
      return new Response(content);
    },
    onProgress: (event) => events.push(event),
    validate: async () => {
      validations++;
      assert.equal(events.at(-1).phase, 'validate:start');
      assert.equal(events.filter(({ phase }) => phase === 'validate:done').length, validations - 1);
    }
  };
  await installModel(model.repository, installOptions);
  assert.deepEqual(
    events.slice(-3).map(({ phase }) => phase),
    ['done', 'validate:start', 'validate:done']
  );
  assert.equal(events.at(-1).dimensions, 384);
  assert.ok(events.at(-1).elapsedMs >= 0);
  events.length = 0;
  // The cached validation has its own lifecycle, without another transfer.
  validations = 0;
  await installModel(model.repository, installOptions);
  assert.equal(fetches, model.files.length);
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ['plan', 'validate:start', 'validate:done']
  );
  assert.equal(events[0].pendingFiles, 0);
  assert.equal(events[0].totalBytes, 0);
});

test('failed validation emits no validation completion or publication', async (t) => {
  const options = await setup(t);
  const events = [];
  const failure = new Error('runtime validation rejected the graph');
  await assert.rejects(
    installModel(model.repository, {
      ...options,
      onProgress: (event) => events.push(event),
      validate: () => {
        throw failure;
      }
    }),
    (error) => error === failure
  );
  assert.equal(events.at(-1).phase, 'validate:start');
  assert.ok(events.some(({ phase }) => phase === 'done'));
  assert.ok(!events.some(({ phase }) => phase === 'validate:done'));
  await assert.rejects(fs.access(path.join(options.directory, 'example', 'lifecycle')), /ENOENT/);
});

for (const failingPhase of ['plan', 'validate:start', 'validate:done']) {
  test(`a cached ${failingPhase} reporting failure propagates without re-downloading`, async (t) => {
    const options = await setup(t);
    await installModel(model.repository, { ...options, validate: async () => {} });
    const failure = new Error('progress observer failed');
    let observed = false;
    await assert.rejects(
      installModel(model.repository, {
        ...options,
        fetchImpl: () => assert.fail('A reporting failure must not trigger another download'),
        validate: async () => {},
        onProgress: ({ phase }) => {
          if (phase === failingPhase && !observed) {
            observed = true;
            throw failure;
          }
        }
      }),
      (error) => error === failure
    );
    assert.equal(observed, true);
  });
}

test('a cached runtime validation failure retains cache repair behavior', async (t) => {
  const options = await setup(t);
  await installModel(model.repository, { ...options, validate: async () => {} });
  let validations = 0;
  let fetches = 0;
  await installModel(model.repository, {
    ...options,
    fetchImpl: async () => {
      fetches++;
      return new Response(content);
    },
    validate: async () => {
      if (++validations === 1) throw new Error('cached runtime validation failed');
    },
    onProgress: () => {}
  });
  assert.equal(validations, 2);
  assert.equal(fetches, model.files.length);
});

test('a contending installer emits one wait message across multiple retries', async (t) => {
  const options = await setup(t);
  let signalValidation;
  let releaseValidation;
  let signalWaiting;
  const validationStarted = new Promise((resolve) => {
    signalValidation = resolve;
  });
  const validationReleased = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const waitingStarted = new Promise((resolve) => {
    signalWaiting = resolve;
  });
  const events = [];
  const owner = installModel(model.repository, {
    ...options,
    validate: async () => {
      signalValidation();
      await validationReleased;
    }
  });
  await validationStarted;
  const waiter = installModel(model.repository, {
    ...options,
    retryMs: 5,
    validate: async () => {},
    onProgress: (event) => {
      events.push(event);
      if (event.phase === 'waiting') signalWaiting();
    }
  });
  const settled = Promise.allSettled([owner, waiter]);
  try {
    await waitingStarted;
    await delay(30);
    assert.equal(events.filter(({ phase }) => phase === 'waiting').length, 1);
    assert.equal(events[0].repository, model.repository);
    assert.equal(events[0].modelDir, path.join(options.directory, 'example', 'lifecycle'));
  } finally {
    releaseValidation();
    await settled;
  }
  assert.equal((await owner).modelDir, (await waiter).modelDir);
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ['waiting', 'plan', 'validate:start', 'validate:done']
  );
});
