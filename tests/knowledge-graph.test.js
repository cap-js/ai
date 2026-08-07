import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

describe('ai-sqlite knowledge graph', () => {
  let db;

  const data = fileURLToPath(new URL('./bookshop/db/data/cap.ttl', import.meta.url));
  const graph = 'https://cap.cloud.sap/example';

  before(async () => {
    db = await cds.connect.to('knowledge-graph-db', {
      kind: 'ai-sqlite',
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
