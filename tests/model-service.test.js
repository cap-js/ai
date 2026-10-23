import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import cds from '@sap/cds';
import AISQLiteService from '../lib/sqlite/AISQLiteService.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('SQLite model lookup configuration', () => {
  test('uses a service-specific root without changing global CAP configuration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-service-root-'));
    temporaryDirectories.push(root);
    const directory = path.join(root, '.cds', 'models', 'example', 'service-model');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'embedding.lock.json'), '{}');
    const originalRoot = cds.root;
    const originalDb = cds.db;
    const originalEmbedding = structuredClone(cds.env.requires.db?.embedding);
    const db = new AISQLiteService('model-root-db', undefined, {
      kind: 'sqlite',
      credentials: { url: ':memory:' },
      embedding: { model: 'example/service-model', root, offline: true }
    });

    await assert.rejects(db.init(), (error) => {
      assert.ok(error.message.includes(directory), error.message);
      assert.ok(
        error.message.includes(
          `--directory ${JSON.stringify(path.join(root, '.cds', 'models'))}`
        ) || error.message.includes(`--directory ${path.join(root, '.cds', 'models')}`),
        error.message
      );
      return true;
    });
    assert.equal(cds.root, originalRoot);
    assert.equal(cds.db, originalDb);
    assert.deepEqual(cds.env.requires.db?.embedding, originalEmbedding);
    assert.equal(await fs.readFile(path.join(directory, 'embedding.lock.json'), 'utf8'), '{}');
  });

  test('enforces offline lookup through real service startup before any network request', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-service-offline-'));
    temporaryDirectories.push(root);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error('offline service must not fetch');
    };
    try {
      const db = new AISQLiteService('offline-model-db', undefined, {
        kind: 'sqlite',
        credentials: { url: ':memory:' },
        embedding: { model: 'example/offline-service-model', root, offline: true }
      });
      await assert.rejects(db.init(), /offline.*install-model example\/offline-service-model/s);
      assert.equal(requests, 0);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
