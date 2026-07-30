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
  });
});
