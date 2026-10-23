import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runModelCommand } from '../../lib/vector_embedding/cli.js';
import { resolveEmbeddingModel } from '../../lib/vector_embedding/embedding.js';
import { installModel } from '../../lib/vector_embedding/model-install.js';
import { downloadFile } from '../../lib/vector_embedding/model-utils.js';
import { createLogProgressReporter } from '../../lib/vector_embedding/progress.js';

const HELP = `Usage: node samples/model-download-progress/demo.js [scenario]

Scenarios:
  healthy     CLI progress (~8s), then reuse the same cache (default)
  startup     Ad-hoc model lookup with startup warning and progress logs (~8s)
  stall       One chunk, then no body bytes: idle timeout (~3s, exit 1)
  headers     No response headers: idle timeout (~2s, exit 1)
  deadline    Bytes keep arriving: absolute download timeout (~2.5s, exit 1)
  legacy      Same deadline using low-level timeoutMs (~2.5s, exit 1)
  concurrent  Two installers share one cache and one download (~8s)

Pipe healthy output to see plain milestone lines instead of a live TTY line:
  node samples/model-download-progress/demo.js healthy | tee /tmp/model-progress.log

All artifacts are synthetic, ONNX validation is bypassed, and no network is used.
Every run uses a new temporary root/home and removes it when the run finishes.
`;

const repository = 'synthetic-demo/not-an-onnx-model';
const artifacts = [
  ['model', 'model.onnx', Buffer.alloc(192 * 1024, 'SYNTHETIC_NOT_ONNX\n')],
  ['tokenizer', 'tokenizer.json', Buffer.from('{"synthetic":true}\n')],
  ['tokenizerConfig', 'tokenizer_config.json', Buffer.from('{"synthetic":true}\n')]
];
const model = {
  repository,
  revision: 'a'.repeat(40),
  dimensions: 2,
  maxLength: 8,
  files: artifacts.map(([role, name, bytes]) => ({
    role,
    name,
    path: name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })),
  output: { name: 'synthetic_output', pooling: 'mean', normalize: true, includePrompt: true }
};

function fixtureTransport(scenario) {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    async fetchImpl(url, { signal }) {
      const artifact = artifacts.find(([, name]) => new URL(url).pathname.endsWith(`/${name}`));
      assert.ok(artifact, `Unexpected fixture URL: ${url}`);
      requests++;
      if (scenario === 'headers') await delay(30_000, undefined, { signal });
      const [, , bytes] = artifact;
      let offset = 0;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            if (scenario === 'stall' && offset > 0) {
              await delay(30_000, undefined, { signal });
            }
            await delay(550, undefined, { signal });
            const end = Math.min(offset + 16 * 1024, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
            if (offset === bytes.length) controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      });
      return new Response(body, { headers: { 'content-length': String(bytes.length) } });
    }
  };
}

async function main() {
  const [scenario = 'healthy', ...extra] = process.argv.slice(2);
  if (scenario === '--help' || scenario === '-h') {
    process.stdout.write(HELP);
    return;
  }
  assert.ok(
    !extra.length &&
      ['healthy', 'startup', 'stall', 'headers', 'deadline', 'legacy', 'concurrent'].includes(
        scenario
      ),
    `Unknown scenario or extra arguments.\n${HELP}`
  );

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-progress-demo-'));
  const transport = fixtureTransport(scenario);
  const options = {
    root: path.join(temporary, 'project'),
    home: path.join(temporary, 'home'),
    hubUrl: 'https://synthetic.invalid',
    fetchImpl: transport.fetchImpl,
    discover: async () => model,
    // Synthetic bytes exercise provisioning, not inference; they are not a usable ONNX model.
    validate: async () => {},
    idleTimeoutMs: 2000,
    downloadTimeoutMs: 30_000
  };
  process.stdout.write(
    `SYNTHETIC DEMO: ${scenario}; no network, ONNX validation bypassed, no usable model.\n` +
      `Temporary root/home: ${temporary} (removed after completion).\n`
  );

  try {
    if (scenario === 'startup') {
      const result = await resolveEmbeddingModel(
        { model: repository },
        {
          ...options,
          downloadIdleTimeoutMs: options.idleTimeoutMs,
          warn: (message) => process.stdout.write(`[startup warning] ${message}\n`),
          log: (message) => process.stdout.write(`[startup] ${message}\n`)
        }
      );
      process.stdout.write(`Startup lookup resolved synthetic artifacts at ${result.modelDir}\n`);
    } else if (scenario === 'concurrent') {
      process.stdout.write('Starting two installers with the same temporary cache...\n');
      const results = await Promise.allSettled(
        ['first', 'second'].map((label) =>
          installModel(repository, {
            ...options,
            retryMs: 100,
            onProgress: createLogProgressReporter({
              log: (message) => process.stdout.write(`[${label}] ${message}\n`)
            })
          })
        )
      );
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      assert.equal(results[0].value.modelDir, results[1].value.modelDir);
      assert.equal(transport.requests, model.files.length);
      process.stdout.write(
        'Both installers finished; only one copy of each fixture was fetched.\n'
      );
    } else if (scenario === 'deadline' || scenario === 'legacy') {
      const deadline = scenario === 'legacy' ? { timeoutMs: 2500 } : { downloadTimeoutMs: 2500 };
      process.stdout.write(`Healthy chunks every 550ms; ${Object.keys(deadline)[0]} = 2500ms.\n`);
      await downloadFile(
        `https://synthetic.invalid/${model.files[0].name}`,
        path.join(temporary, model.files[0].name),
        model.files[0],
        {
          fetchImpl: transport.fetchImpl,
          idleTimeoutMs: options.idleTimeoutMs,
          ...deadline,
          onChunk: (bytes) => process.stdout.write(`Received ${bytes} bytes\n`)
        }
      );
      throw new Error('Expected an absolute timeout, but the download completed.');
    } else {
      const argv = ['install-model', repository];
      await runModelCommand(argv, options);
      if (scenario === 'healthy') {
        process.stdout.write(
          'Repeating the install: the verified cache must avoid another fetch.\n'
        );
        await runModelCommand(argv, options);
        assert.equal(transport.requests, model.files.length);
        process.stdout.write('Cache reuse verified.\n');
      }
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    process.stdout.write(`Removed temporary artifacts: ${temporary}\n`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
