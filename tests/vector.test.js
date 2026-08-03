import { describe, test } from 'node:test';
import assert from 'node:assert';
import { vector_embedding } from '../lib/vector_handling/sync-wrapper.js';

describe('Vector embedding function (standalone)', () => {
  describe('vector_embedding', () => {
    test('computes embedding with ONNX model', async () => {
      const result = vector_embedding('Hello world', 'DOCUMENT', 'SAP_GXY.20250407');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Embedding should be an array');
      assert.strictEqual(embedding.length, 384, 'Embedding should have 384 dimensions');

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
      assert.ok(embedding.every(v => v === 0), 'Empty text should return all zeros');
    });

    test('handles null text', async () => {
      const result = vector_embedding(null, 'DOCUMENT', 'SAP_GXY.20250407');

      const embedding = JSON.parse(result);
      assert.ok(Array.isArray(embedding), 'Null text should return zero vector');
      assert.strictEqual(embedding.length, 384, 'Should have 384 dimensions');
      assert.ok(embedding.every(v => v === 0), 'Null text should return all zeros');
    });

    test('uses correct dimensions for different models', async () => {
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
