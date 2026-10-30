import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

const require = createRequire(import.meta.url);
const [major, minor] = require('@cap-js/sqlite/package.json').version.split('.').map(Number);
// The CDS 9 CI stack uses SQLite 2, which predates the distance functions.
const distanceExecution = { skip: major < 3 || (major === 3 && minor < 1) };
const text = 'a small cat';

describe('SQLite vector embedding shorthand', () => {
  cds.test(fileURLToPath(new URL('./fixtures/vector-shorthand', import.meta.url)));
  let queryEmbedding, documentEmbedding, cosine, distance;

  before(async () => {
    [{ queryEmbedding, documentEmbedding }] = await cds.db.run(
      "SELECT vector_embedding(?,'QUERY') AS queryEmbedding, vector_embedding(?,'DOCUMENT') AS documentEmbedding",
      [text, text]
    );
    assert.notEqual(queryEmbedding, documentEmbedding);
    await cds.db.run(cds.ql.INSERT.into('Books').entries({ ID: 1, embedding: documentEmbedding }));
    if (!distanceExecution.skip) {
      [{ cosine, distance }] = await cds.db.run(
        'SELECT cosine_similarity(?,?) AS cosine, l2distance(?,?) AS distance',
        [documentEmbedding, queryEmbedding, documentEmbedding, queryEmbedding]
      );
    }
  });

  describe('CQN rendering', () => {
    test("vector_embedding('string')", () => {
      const query = cds.ql`SELECT from Books as B { vector_embedding(${text}) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes("vector_embedding(?,'QUERY')"), sql);
    });

    test("cosine_similarity(embedding, 'string')", () => {
      const query = cds.ql`SELECT from Books as B { cosine_similarity(embedding, ${text}) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes("cosine_similarity(B.embedding,vector_embedding(?,'QUERY'))"), sql);
    });

    test("l2distance(embedding, 'string')", () => {
      const query = cds.ql`SELECT from Books as B { l2distance(embedding, ${text}) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes("l2distance(B.embedding,vector_embedding(?,'QUERY'))"), sql);
    });

    test("cosine_similarity(embedding, vector_embedding('string'))", () => {
      const query = cds.ql`SELECT from Books as B { cosine_similarity(embedding, vector_embedding(${text})) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes("cosine_similarity(B.embedding,vector_embedding(?,'QUERY'))"), sql);
    });

    test("l2distance(embedding, vector_embedding('string'))", () => {
      const query = cds.ql`SELECT from Books as B { l2distance(embedding, vector_embedding(${text})) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes("l2distance(B.embedding,vector_embedding(?,'QUERY'))"), sql);
    });

    test('cosine_similarity preserves normalized operands', () => {
      const query = cds.ql`SELECT from Books as B { cosine_similarity(l2normalize(embedding), l2normalize(vector_embedding(${text}))) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(
        sql.includes(
          "cosine_similarity(l2normalize(B.embedding),l2normalize(vector_embedding(?,'QUERY')))"
        ),
        sql
      );
    });

    test('l2distance preserves normalized operands', () => {
      const query = cds.ql`SELECT from Books as B { l2distance(l2normalize(embedding), l2normalize(vector_embedding(${text}))) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(
        sql.includes(
          "l2distance(l2normalize(B.embedding),l2normalize(vector_embedding(?,'QUERY')))"
        ),
        sql
      );
    });

    test('supports uppercase function names', () => {
      const query = cds.ql`SELECT from Books as B { COSINE_SIMILARITY(embedding, ${text}) as cosine, L2DISTANCE(embedding, VECTOR_EMBEDDING(${text})) as distance }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes("cosine_similarity(B.embedding,vector_embedding(?,'QUERY'))"), sql);
      assert.ok(sql.includes("l2distance(B.embedding,vector_embedding(?,'QUERY'))"), sql);
    });

    test('preserves an explicit DOCUMENT text type', () => {
      const query = cds.ql`SELECT from Books as B { vector_embedding(${text}, ${'DOCUMENT'}) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes('vector_embedding(?,?)'), sql);
      assert.ok(!sql.includes("'QUERY'"), sql);
    });

    test('cosine_similarity leaves a cast vector unchanged', () => {
      const query = cds.ql`SELECT from Books as B { cosine_similarity(embedding, cast(${'[1,0]'} as Vector)) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(!sql.includes('vector_embedding('), sql);
      assert.ok(/cast\(\? as /i.test(sql), sql);
    });

    test('l2distance leaves a cast vector unchanged', () => {
      const query = cds.ql`SELECT from Books as B { l2distance(embedding, cast(${'[1,0]'} as Vector)) as result }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(!sql.includes('vector_embedding('), sql);
      assert.ok(/cast\(\? as /i.test(sql), sql);
    });

    test('leaves vector references unchanged', () => {
      const query = cds.ql`SELECT from Books as B { cosine_similarity(embedding, embedding) as cosine, l2distance(embedding, embedding) as distance }`;
      const { sql } = cds.db.cqn2sql(query);
      assert.ok(sql.includes('cosine_similarity(B.embedding,B.embedding)'), sql);
      assert.ok(sql.includes('l2distance(B.embedding,B.embedding)'), sql);
      assert.ok(!sql.includes('vector_embedding('), sql);
    });

    test('leaves reusable CQN unchanged', () => {
      const query = cds.ql`SELECT from Books as B { cosine_similarity(embedding, ${text}) as cosine, l2distance(embedding, ${text}) as distance }`;
      const original = JSON.stringify(query);
      const first = cds.db.cqn2sql(query);
      const second = cds.db.cqn2sql(query);
      assert.equal(second.sql, first.sql);
      assert.deepEqual(second.values, first.values);
      assert.equal(JSON.stringify(query), original);
    });
  });

  describe('local execution', () => {
    test('vector_embedding defaults to the configured QUERY prompt', async () => {
      const query = cds.ql`SELECT from Books { vector_embedding(${text}) as result }`;
      const [row] = await cds.db.run(query);
      assert.equal(row.result, queryEmbedding);
    });

    test('preserves an explicit DOCUMENT text type', async () => {
      const query = cds.ql`SELECT from Books { vector_embedding(${text}, ${'DOCUMENT'}) as result }`;
      const [row] = await cds.db.run(query);
      assert.equal(row.result, documentEmbedding);
    });

    test("cosine_similarity(embedding, 'string')", distanceExecution, async () => {
      const query = cds.ql`SELECT from Books { cosine_similarity(embedding, ${text}) as result }`;
      const [row] = await cds.db.run(query);
      assert.ok(Math.abs(row.result - cosine) < 1e-6);
    });

    test("l2distance(embedding, 'string')", distanceExecution, async () => {
      const query = cds.ql`SELECT from Books { l2distance(embedding, ${text}) as result }`;
      const [row] = await cds.db.run(query);
      assert.ok(Math.abs(row.result - distance) < 1e-6);
    });

    test(
      "cosine_similarity(embedding, vector_embedding('string'))",
      distanceExecution,
      async () => {
        const query = cds.ql`SELECT from Books { cosine_similarity(embedding, vector_embedding(${text})) as result }`;
        const [row] = await cds.db.run(query);
        assert.ok(Math.abs(row.result - cosine) < 1e-6);
      }
    );

    test("l2distance(embedding, vector_embedding('string'))", distanceExecution, async () => {
      const query = cds.ql`SELECT from Books { l2distance(embedding, vector_embedding(${text})) as result }`;
      const [row] = await cds.db.run(query);
      assert.ok(Math.abs(row.result - distance) < 1e-6);
    });
  });
});
