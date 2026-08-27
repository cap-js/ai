import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

describe('ai-sqlite knowledge graph', () => {
  let db;

  const data = fileURLToPath(new URL('./bookshop/db/data/cap.ttl', import.meta.url));
  const graph = 'https://cap.cloud.sap/example';

  before(async () => {
    db = await cds.connect.to('knowledge-graph-db', {
      kind: 'ai-sqlite',
      embedding: { model: 'Xenova/all-MiniLM-L6-v2' },
      credentials: { url: ':memory:' }
    });
  });

  beforeEach(async () => {
    await db.disconnect();
  });

  after(async () => {
    await db?.disconnect();
  });

  test('loads Turtle data', async () => {
    await load(data);
    assert.strictEqual((await triples()).length, 13);
  });

  test('loads compressed Turtle data', async () => {
    await load(`${data}.gz`);
    assert.strictEqual((await triples()).length, 13);
  });

  test('rejects malformed SPARQL_EXECUTE calls', async () => {
    await assert.rejects(
      db.run(`CALL SPARQL_EXECUTE('SELECT * WHERE { ?s ?p ?o }')`),
      /Unsupported SPARQL_EXECUTE syntax/
    );
  });

  test('rejects RDF files outside the project', async () => {
    await assert.rejects(
      db.run(`CALL SPARQL_EXECUTE('LOAD </etc/passwd>','', ?, ?)`),
      /outside the project/
    );
  });

  test('rejects project-local symlinks pointing outside the project', async () => {
    const link = path.join(cds.root, 'tests/bookshop/db/data/outside.ttl');
    await symlink('/etc/passwd', link);
    try {
      await assert.rejects(
        db.run(`CALL SPARQL_EXECUTE('LOAD <${link}>','', ?, ?)`),
        /outside the project/
      );
    } finally {
      await unlink(link);
    }
  });

  test('checks RDF format before trying to open the file', async () => {
    await assert.rejects(
      db.run(`CALL SPARQL_EXECUTE('LOAD <${data}.unsupported>','', ?, ?)`),
      /Unsupported RDF file format: .unsupported/
    );
  });

  test('supports SPARQL prologues and SELECT without WHERE', async () => {
    await load(data);
    const result = await db.run({
      SELECT: {
        from: cds.ql.func(
          'sparql_table',
          `BASE <https://cap.cloud.sap/>\nPREFIX cap: <https://cap.cloud.sap/>\nSELECT ?subject ?predicate { ?subject ?predicate ?object . }`
        )
      }
    });
    assert.ok(result.length > 0);
    assert.deepStrictEqual(Object.keys(result[0]), ['subject', 'predicate']);
  });

  test('keeps a graph unchanged when a valid RDF file is malformed', async () => {
    await load(data);
    const malformed = path.join(cds.root, 'tests/bookshop/db/data/malformed.ttl');
    await writeFile(
      malformed,
      '<https://cap.cloud.sap/test> <https://cap.cloud.sap/test> <https://cap.cloud.sap/test> .\nnot turtle'
    );
    try {
      await assert.rejects(load(malformed));
      assert.strictEqual((await triples()).length, 13);
    } finally {
      await unlink(malformed);
    }
  });

  async function load(file) {
    return db.run(`CALL SPARQL_EXECUTE('LOAD <${file}> INTO GRAPH <${graph}>','', ?, ?)`);
  }

  async function triples() {
    return db.run({
      SELECT: {
        from: cds.ql.func(
          'sparql_table',
          'SELECT ?subject ?predicate ?object WHERE { ?subject ?predicate ?object . }'
        )
      }
    });
  }
});
