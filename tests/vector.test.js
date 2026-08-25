import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import { initializeEmbedding, vector_embedding } from '../lib/vector_embedding/index.js';
import { DEFAULT_MODEL } from '../lib/vector_embedding/embedding.js';

let embeddingModule;

before(async () => {
  embeddingModule = await initializeEmbedding();
});

describe('Vector embedding function (standalone)', () => {
  describe('vector_embedding', () => {
    test('computes embedding with ONNX model', async () => {
      const result = vector_embedding('Hello world', 'DOCUMENT', 'SAP_GXY.20250407');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Embedding should be an array');

      // Check that values are floats in reasonable range
      embedding.forEach((val, idx) => {
        assert.strictEqual(typeof val, 'number', `Value at index ${idx} should be a number`);
        assert.ok(Math.abs(val) <= 1, `Value at index ${idx} should be normalized (-1 to 1)`);
      });
    });

    test('deterministic - same input produces same output', async () => {
      const e1 = vector_embedding('test text', 'DOCUMENT', 'SAP_GXY.20250407');
      const e2 = vector_embedding('test text', 'DOCUMENT', 'SAP_GXY.20250407');

      assert.strictEqual(e1, e2, 'Same input should produce identical embeddings');
    });

    test('ignores text beyond the first model input window', () => {
      const firstWindow = new Array(126).fill('token').join(' ');
      const truncated = vector_embedding(firstWindow, 'DOCUMENT', 'SAP_GXY.20250407');
      const withAdditionalText = vector_embedding(
        `${firstWindow} this text must not affect the embedding`,
        'DOCUMENT',
        'SAP_GXY.20250407'
      );

      assert.strictEqual(withAdditionalText, truncated);
    });

    test('different inputs produce different outputs', async () => {
      const e1 = vector_embedding('hello world', 'DOCUMENT', 'SAP_GXY.20250407');
      const e2 = vector_embedding('goodbye world', 'DOCUMENT', 'SAP_GXY.20250407');

      assert.notStrictEqual(e1, e2, 'Different inputs should produce different embeddings');
    });

    test('semantically similar sentences produce similar vectors', async () => {
      const e1 = vector_embedding('I love programming', 'DOCUMENT', 'SAP_GXY.20250407');
      const e2 = vector_embedding('I enjoy coding', 'DOCUMENT', 'SAP_GXY.20250407');

      const v1 = JSON.parse(e1);
      const v2 = JSON.parse(e2);

      const similarity = cosineSimilarity(v1, v2);
      assert.ok(
        similarity > 0.8,
        `Semantically similar sentences should have high cosine similarity (got ${similarity.toFixed(3)})`
      );
    });

    test('semantically different sentences are far apart in vector space', async () => {
      const e1 = vector_embedding('The cat sat on the mat', 'DOCUMENT', 'SAP_GXY.20250407');
      const e2 = vector_embedding('Quantum physics is fascinating', 'DOCUMENT', 'SAP_GXY.20250407');

      const v1 = JSON.parse(e1);
      const v2 = JSON.parse(e2);

      const similarity = cosineSimilarity(v1, v2);
      assert.ok(
        similarity < 0.1,
        `Semantically different sentences should have low cosine similarity (got ${similarity.toFixed(3)})`
      );
    });

    test('handles empty text', async () => {
      const result = vector_embedding('', 'DOCUMENT', 'SAP_GXY.20250407');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Empty text should return zero vector');
      assert.strictEqual(embedding.length, 384, 'Should have 384 dimensions');
      assert.ok(
        embedding.every((v) => v === 0),
        'Empty text should return all zeros'
      );
    });

    test('handles null text', async () => {
      const result = vector_embedding(null, 'DOCUMENT', 'SAP_GXY.20250407');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Null text should return zero vector');
      assert.strictEqual(embedding.length, 384, 'Should have 384 dimensions');
      assert.ok(
        embedding.every((v) => v === 0),
        'Null text should return all zeros'
      );
    });

    test('embeds text longer than the MiniLM token limit', () => {
      const result = vector_embedding(
        new Array(300).fill('semantic').join(' '),
        'DOCUMENT',
        'SAP_GXY.20250407'
      );

      assert.strictEqual(JSON.parse(result).length, 384);
    });

    test('uses the configured dimensions for compatibility model identifiers', async () => {
      const result1 = vector_embedding('test', 'DOCUMENT', 'SAP_GXY.20250407');
      const embedding1 = JSON.parse(result1);
      assert.strictEqual(embedding1.length, 384, 'SAP_GXY.20250407 should have 384 dimensions');

      const result2 = vector_embedding('test', 'DOCUMENT', 'SAP_GXY.20240715');
      const embedding2 = JSON.parse(result2);
      assert.strictEqual(embedding2.length, 384, 'SAP_GXY.20240715 should have 384 dimensions');

      const result3 = vector_embedding('test', 'DOCUMENT', 'unknown_model');
      const embedding3 = JSON.parse(result3);
      assert.strictEqual(embedding3.length, 384, 'Unknown model should default to 384 dimensions');
    });

    test('retains the embedding module wrapper', () => {
      const result = embeddingModule.embedding('Hello world');

      assert.equal(result.content, 'Hello world');
      assert.equal(result.embedding.length, 384);
      assert.deepEqual(Object.keys(result), ['content']);
    });
  });
});

describe('ai-sqlite integration', () => {
  let db;

  before(async () => {
    db = await cds.connect.to('vector-db', {
      kind: 'ai-sqlite',
      credentials: { url: ':memory:' }
    });
  });

  after(async () => {
    await db?.disconnect();
  });

  test('registers VECTOR_EMBEDDING for three and four arguments', async () => {
    const [row] = await db.run(`SELECT
      VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407') AS local,
      VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407', 'remote') AS remote`);

    assert.strictEqual(JSON.parse(row.local).length, 384);
    assert.strictEqual(row.remote, row.local);
  });

  test('preserves SQL null semantics', async () => {
    const [row] = await db.run(
      `SELECT VECTOR_EMBEDDING(NULL, 'DOCUMENT', 'SAP_GXY.20250407') AS embedding`
    );

    assert.strictEqual(row.embedding, null);
  });

  test('validates a model descriptor supplied through the service options', async () => {
    await assert.rejects(
      cds.connect.to('invalid-vector-db', {
        kind: 'ai-sqlite',
        embedding: { ...DEFAULT_MODEL, revision: 'main' },
        credentials: { url: ':memory:' }
      }),
      /immutable 40-64 character commit hash/
    );
  });

  test('keeps custom model behavior scoped to its service', async () => {
    const customDb = await cds.connect.to('unnormalized-vector-db', {
      kind: 'ai-sqlite',
      embedding: {
        ...DEFAULT_MODEL,
        output: { ...DEFAULT_MODEL.output, normalize: false }
      },
      credentials: { url: ':memory:' }
    });

    try {
      const [defaultRow] = await db.run(
        `SELECT VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407') AS embedding`
      );
      const [customRow] = await customDb.run(
        `SELECT VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407') AS embedding`
      );
      const defaultNorm = vectorNorm(JSON.parse(defaultRow.embedding));
      const customNorm = vectorNorm(JSON.parse(customRow.embedding));

      assert.ok(Math.abs(defaultNorm - 1) < 1e-5);
      assert.ok(Math.abs(customNorm - 1) > 1e-3);
    } finally {
      await customDb.disconnect();
    }
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

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}
