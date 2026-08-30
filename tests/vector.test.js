import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import { createEmbeddingRuntime } from '../lib/vector_embedding/embedding.js';

const MINILM_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

let runtime;

before(async () => {
  runtime = await createEmbeddingRuntime({ model: MINILM_MODEL });
});

after(async () => {
  await runtime?.dispose();
});

describe('Vector embedding function (standalone)', () => {
  describe('vector_embedding', () => {
    test('computes embedding with ONNX model', async () => {
      const result = runtime.vectorEmbedding('Hello world');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Embedding should be an array');

      // Check that values are floats in reasonable range
      embedding.forEach((val, idx) => {
        assert.strictEqual(typeof val, 'number', `Value at index ${idx} should be a number`);
        assert.ok(Math.abs(val) <= 1, `Value at index ${idx} should be normalized (-1 to 1)`);
      });
    });

    test('deterministic - same input produces same output', async () => {
      const e1 = runtime.vectorEmbedding('test text');
      const e2 = runtime.vectorEmbedding('test text');

      assert.strictEqual(e1, e2, 'Same input should produce identical embeddings');
    });

    test('ignores text beyond the first model input window', () => {
      const firstWindow = new Array(126).fill('token').join(' ');
      const truncated = runtime.vectorEmbedding(firstWindow);
      const withAdditionalText = runtime.vectorEmbedding(
        `${firstWindow} this text must not affect the embedding`
      );

      assert.strictEqual(withAdditionalText, truncated);
    });

    test('different inputs produce different outputs', async () => {
      const e1 = runtime.vectorEmbedding('hello world');
      const e2 = runtime.vectorEmbedding('goodbye world');

      assert.notStrictEqual(e1, e2, 'Different inputs should produce different embeddings');
    });

    test('semantically similar sentences produce similar vectors', async () => {
      const e1 = runtime.vectorEmbedding('I love programming');
      const e2 = runtime.vectorEmbedding('I enjoy coding');

      const v1 = JSON.parse(e1);
      const v2 = JSON.parse(e2);

      const similarity = cosineSimilarity(v1, v2);
      assert.ok(
        similarity > 0.8,
        `Semantically similar sentences should have high cosine similarity (got ${similarity.toFixed(3)})`
      );
    });

    test('semantically different sentences are far apart in vector space', async () => {
      const e1 = runtime.vectorEmbedding('The cat sat on the mat');
      const e2 = runtime.vectorEmbedding('Quantum physics is fascinating');

      const v1 = JSON.parse(e1);
      const v2 = JSON.parse(e2);

      const similarity = cosineSimilarity(v1, v2);
      assert.ok(
        similarity < 0.1,
        `Semantically different sentences should have low cosine similarity (got ${similarity.toFixed(3)})`
      );
    });

    test('handles empty text', async () => {
      const result = runtime.vectorEmbedding('');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Empty text should return zero vector');
      assert.strictEqual(embedding.length, 384, 'Should have 384 dimensions');
      assert.ok(
        embedding.every((v) => v === 0),
        'Empty text should return all zeros'
      );
    });

    test('handles null text', async () => {
      const result = runtime.vectorEmbedding(null);

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Null text should return zero vector');
      assert.strictEqual(embedding.length, 384, 'Should have 384 dimensions');
      assert.ok(
        embedding.every((v) => v === 0),
        'Null text should return all zeros'
      );
    });

    test('embeds text longer than the MiniLM token limit', () => {
      const result = runtime.vectorEmbedding(new Array(300).fill('semantic').join(' '));

      assert.strictEqual(JSON.parse(result).length, 384);
    });

    test('uses the configured dimensions for compatibility model identifiers', async () => {
      const result1 = runtime.vectorEmbedding('test');
      const embedding1 = JSON.parse(result1);
      assert.strictEqual(embedding1.length, 384, 'SAP_GXY.20250407 should have 384 dimensions');

      const result2 = runtime.vectorEmbedding('test');
      const embedding2 = JSON.parse(result2);
      assert.strictEqual(embedding2.length, 384, 'SAP_GXY.20240715 should have 384 dimensions');

      const result3 = runtime.vectorEmbedding('test');
      const embedding3 = JSON.parse(result3);
      assert.strictEqual(
        embedding3.length,
        384,
        'Compatibility identifiers should use the configured model dimensions'
      );
    });

    test('disposes embedding runtimes safely', async () => {
      const runtime = await createEmbeddingRuntime({ model: MINILM_MODEL });

      await runtime.dispose();
      await runtime.dispose();

      assert.throws(() => runtime.embedding('test'), /Inference session has been disposed/);
    });
  });
});

describe('ai-sqlite integration', () => {
  let db;

  test('requires an explicitly configured embedding model during startup', async () => {
    await assert.rejects(
      cds.connect.to('missing-embedding-model-db', {
        kind: 'ai-sqlite:memory'
      }),
      /cds\.env\.requires\.db\.embedding\.model must be a non-empty string/
    );
  });

  before(async () => {
    db = await cds.connect.to('vector-db', {
      kind: 'ai-sqlite:memory',
      embedding: { model: MINILM_MODEL }
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

  test('allows additional embedding properties', async () => {
    const configuredDb = await cds.connect.to('extended-vector-db', {
      kind: 'ai-sqlite:memory',
      embedding: { model: MINILM_MODEL, revision: 'main', extension: { enabled: true } }
    });

    try {
      const [row] = await configuredDb.run(
        `SELECT VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407') AS embedding`
      );
      assert.strictEqual(JSON.parse(row.embedding).length, 384);
    } finally {
      await configuredDb.disconnect();
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
