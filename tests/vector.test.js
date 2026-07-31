import path from 'path';
import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import cdsTest from '@cap-js/cds-test';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize cds test environment
cdsTest(path.join(__dirname, './bookshop'));

describe('Vector functions (SQLite only)', () => {
  let db;

  before(async () => {
    db = cds.db || (await cds.connect.to('db'));
  });

  describe('VECTOR_EMBEDDING', () => {
    test('computes embedding with ONNX model', async () => {
      if (db?.kind !== 'sqlite') {
        console.log('Skipping - not SQLite');
        return;
      }

      const result = await db.run(
        `SELECT VECTOR_EMBEDDING(title, 'DOCUMENT', 'SAP_GXY.20250407') as embedding
         FROM sap_capire_bookshop_Books LIMIT 1`
      );

      const embedding = JSON.parse(result[0].embedding);
      assert.ok(Array.isArray(embedding), 'Embedding should be an array');
      assert.strictEqual(embedding.length, 384, 'Embedding should have 384 dimensions');

      // Check that values are floats in reasonable range
      embedding.forEach((val, idx) => {
        assert.strictEqual(typeof val, 'number', `Value at index ${idx} should be a number`);
        assert.ok(Math.abs(val) <= 1, `Value at index ${idx} should be normalized (-1 to 1)`);
      });
    });

    test('deterministic - same input produces same output', async () => {
      if (db?.kind !== 'sqlite') return;

      const result = await db.run(
        `SELECT
          VECTOR_EMBEDDING('test text', 'DOCUMENT', 'SAP_GXY.20250407') as e1,
          VECTOR_EMBEDDING('test text', 'DOCUMENT', 'SAP_GXY.20250407') as e2`
      );

      assert.strictEqual(result[0].e1, result[0].e2, 'Same input should produce identical embeddings');
    });

    test('different inputs produce different outputs', async () => {
      if (db?.kind !== 'sqlite') return;

      const result = await db.run(
        `SELECT
          VECTOR_EMBEDDING('hello world', 'DOCUMENT', 'SAP_GXY.20250407') as e1,
          VECTOR_EMBEDDING('goodbye world', 'DOCUMENT', 'SAP_GXY.20250407') as e2`
      );

      assert.notStrictEqual(result[0].e1, result[0].e2, 'Different inputs should produce different embeddings');
    });

    test('semantically similar sentences produce similar vectors', async () => {
      if (db?.kind !== 'sqlite') return;

      const result = await db.run(
        `SELECT
          VECTOR_EMBEDDING('I love programming', 'DOCUMENT', 'SAP_GXY.20250407') as e1,
          VECTOR_EMBEDDING('I enjoy coding', 'DOCUMENT', 'SAP_GXY.20250407') as e2`
      );

      const v1 = JSON.parse(result[0].e1);
      const v2 = JSON.parse(result[0].e2);

      const similarity = cosineSimilarity(v1, v2);
      assert.ok(similarity > 0.8, `Semantically similar sentences should have high cosine similarity (got ${similarity.toFixed(3)})`);
    });

    test('semantically different sentences are far apart in vector space', async () => {
      if (db?.kind !== 'sqlite') return;

      const result = await db.run(
        `SELECT
          VECTOR_EMBEDDING('The cat sat on the mat', 'DOCUMENT', 'SAP_GXY.20250407') as e1,
          VECTOR_EMBEDDING('Quantum physics is fascinating', 'DOCUMENT', 'SAP_GXY.20250407') as e2`
      );

      const v1 = JSON.parse(result[0].e1);
      const v2 = JSON.parse(result[0].e2);

      const similarity = cosineSimilarity(v1, v2);
      assert.ok(similarity < 0.1, `Semantically different sentences should have low cosine similarity (got ${similarity.toFixed(3)})`);
    });

    test('4-parameter version with remote_source works', async () => {
      if (db?.kind !== 'sqlite') return;

      const result = await db.run(
        `SELECT VECTOR_EMBEDDING('test text', 'DOCUMENT', 'SAP_GXY.20250407', 'MY_GENAI_HUB_REMOTE_SOURCE') as embedding`
      );

      const embedding = JSON.parse(result[0].embedding);
      assert.ok(Array.isArray(embedding), 'Embedding should be an array');
      assert.strictEqual(embedding.length, 384, 'Embedding should have 384 dimensions');

      // Note: In real HANA, remote_source would connect to SAP AI Core.
      // In our SQLite implementation, we ignore it and use local ONNX model.
    });
  });
});

// Helper function to calculate cosine similarity between two vectors
function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vectors must have the same length');

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
