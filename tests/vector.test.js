import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import { loadSQLiteService } from '../lib/sqlite/load-sqlite.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installModel } from '@cap-js/ai/models.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  createEmbeddingRuntime,
  createEmbeddingRuntimeFromModel,
  resolveEmbeddingModel
} from '../lib/vector_embedding/embedding.js';

const MINILM_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const AI_SQLITE_IMPL = '@cap-js/ai/lib/sqlite/AISQLiteService.js';
const [CDS_MAJOR, CDS_MINOR] = cds.version.split('.').map(Number);
const HAS_HANA_EMBEDDING_CONFIG = CDS_MAJOR > 10 || (CDS_MAJOR === 10 && CDS_MINOR >= 2);
const HAS_VECTOR_ADAPTER =
  typeof loadSQLiteService().CQN2SQL.Functions.vector_embedding === 'function';

let runtime;

before(async () => {
  runtime = await createEmbeddingRuntime();
});

after(async () => {
  await runtime?.dispose();
});

describe('Vector embedding function (standalone)', () => {
  test('validates an installed model through the public provisioning API by default', async () => {
    const { model, modelDir, modelRoot } = await installModel(MINILM_MODEL, {
      directory: '.cds/models',
      root: process.cwd(),
      discover: () => assert.fail('an installed lock must not trigger discovery'),
      fetchImpl: () => assert.fail('a valid installation must not download')
    });
    assert.strictEqual(model.repository, MINILM_MODEL);
    assert.strictEqual(modelRoot, path.join(process.cwd(), '.cds', 'models'));
    assert.strictEqual(modelDir, path.join(modelRoot, ...MINILM_MODEL.split('/')));

    // Valid integrity metadata must not let an unusable ONNX graph become an installation.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-ai-invalid-onnx-'));
    const content = Buffer.from('not an ONNX graph');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const invalidModel = {
      ...model,
      files: model.files.map((file) => ({ ...file, size: content.length, sha256 }))
    };
    try {
      await assert.rejects(
        installModel(MINILM_MODEL, {
          directory: '.cds/models',
          root,
          discover: () => invalidModel,
          fetchImpl: async () => new Response(content)
        })
      );
      await assert.rejects(
        fs.access(path.join(root, '.cds', 'models', ...MINILM_MODEL.split('/'))),
        /ENOENT/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

describe('text-type prompts via configured prompts', () => {
  let promptRuntime;

  // MiniLM ships no Sentence-Transformers prompts, so there is nothing to discover.
  // These prefixes come from `embedding.prompts.{query,document}`, the user-configured override that
  // takes precedence over discovered prompts — the path a prompt-trained model without
  // discoverable prompts relies on.
  const PROMPTS = { query: 'query: ', document: 'document: ' };

  before(async () => {
    const { model, modelDir } = await resolveEmbeddingModel({
      model: MINILM_MODEL,
      prompts: PROMPTS
    });
    promptRuntime = await createEmbeddingRuntimeFromModel(modelDir, model);
  });

  after(async () => {
    await promptRuntime?.dispose();
  });

  test('should prepend the configured prompt for the forwarded text-type', () => {
    assert.strictEqual(
      promptRuntime.vectorEmbedding('a small cat', 'QUERY'),
      runtime.vectorEmbedding('query: a small cat')
    );
  });

  test('should prepend the configured document prefix for the DOCUMENT text type', () => {
    assert.strictEqual(
      promptRuntime.vectorEmbedding('a small cat', 'DOCUMENT'),
      runtime.vectorEmbedding('document: a small cat')
    );
  });

  test('should ignore the text type when no prefix is configured', () => {
    assert.strictEqual(
      runtime.vectorEmbedding('a small cat', 'QUERY'),
      runtime.vectorEmbedding('a small cat', 'DOCUMENT')
    );
    assert.strictEqual(
      runtime.vectorEmbedding('a small cat', 'QUERY'),
      runtime.vectorEmbedding('a small cat')
    );
  });

  test('should reject a non-string configured prompt before touching the model', async () => {
    await assert.rejects(
      resolveEmbeddingModel({ model: MINILM_MODEL, prompts: { query: 42 } }),
      /embedding\.prompts\.query must be a non-empty string/
    );
  });
});

describe('SQLite integration', () => {
  let db;

  test('enables the embeddings configuration independently of the local model', () => {
    const { embeddings } = cds.env.requires;
    if (!HAS_HANA_EMBEDDING_CONFIG) {
      assert.strictEqual(embeddings, true);
    } else {
      assert.strictEqual(embeddings.model, 'SAP_GXY.20250407');
      assert.strictEqual(embeddings.model_kind, 'embeddings');
      assert.notStrictEqual(embeddings.model, cds.env.requires.kinds.sqlite.embedding.model);
    }
  });

  test('uses the default embedding model', () => {
    assert.strictEqual(DEFAULT_EMBEDDING_MODEL, MINILM_MODEL);
    const kind = cds.env.requires.kinds.sqlite;
    assert.strictEqual(kind.impl, AI_SQLITE_IMPL);
    assert.strictEqual(kind.embedding.model, DEFAULT_EMBEDDING_MODEL);
  });

  const memoryKind = cds.env.requires.kinds['sqlite:memory'];
  test(
    'inherits the AI-enabled sqlite kind for sqlite:memory',
    {
      skip: memoryKind?.kind !== 'sqlite'
    },
    () => {
      assert.strictEqual(memoryKind.impl, AI_SQLITE_IMPL);
      assert.strictEqual(memoryKind.embedding.model, DEFAULT_EMBEDDING_MODEL);
      assert.strictEqual(memoryKind.credentials.url, ':memory:');
      assert.strictEqual(memoryKind.pool.evictionRunIntervalMillis, 0);
      assert.strictEqual(memoryKind.pool.min, 1);
      assert.strictEqual(memoryKind.pool.max, 1);
    }
  );

  before(async () => {
    db = await cds.connect.to(
      'vector-db',
      memoryKind?.kind === 'sqlite'
        ? { kind: 'sqlite:memory' }
        : { kind: 'sqlite', credentials: { url: ':memory:' } }
    );
  });

  after(async () => {
    await db?.disconnect();
  });

  test('keeps the local model for HANA model and remote-source arguments', async () => {
    const [row] = await db.run(`SELECT
      VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407') AS defaultModel,
      VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'a-secondary-hana-model') AS selectedModel,
      VECTOR_EMBEDDING('Hello world', 'DOCUMENT', 'SAP_GXY.20250407', 'remote') AS remote`);

    assert.strictEqual(JSON.parse(row.defaultModel).length, 384);
    assert.strictEqual(row.selectedModel, row.defaultModel);
    assert.strictEqual(row.remote, row.defaultModel);
  });

  test('preserves SQL null semantics', async () => {
    const [row] = await db.run(
      `SELECT VECTOR_EMBEDDING(NULL, 'DOCUMENT', 'SAP_GXY.20250407') AS embedding`
    );

    assert.strictEqual(row.embedding, null);
  });

  test('allows additional embedding properties', async () => {
    const configuredDb = await cds.connect.to('extended-vector-db', {
      kind: 'sqlite',
      credentials: { url: ':memory:' },
      embedding: { revision: 'main', extension: { enabled: true } }
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

describe(
  'CQN embedding defaults with the local SQLite runtime',
  {
    skip: !HAS_VECTOR_ADAPTER && 'CQN defaults require the upcoming SQLite vector adapter release'
  },
  () => {
    const TEXT = 'a small cat';
    const PROMPTS = { query: 'query: ', document: 'document: ' };
    let db;
    let embeddings;
    let selectedEmbeddings;

    before(async () => {
      embeddings = cds.env.requires.embeddings;
      selectedEmbeddings = cds.env.requires['selected-embeddings'];
      cds.env.requires.embeddings = {};
      cds.env.requires['selected-embeddings'] = {
        model: 'SELECTED.HANA.MODEL',
        model_kind: 'embeddings'
      };
      const model = cds.linked(
        cds.compile.to.csn(`
        entity EmbeddingDocuments {
          key ID : Integer;
          @cds.embeddings.model: 'selected-embeddings'
          selected : Vector;
          fallback : Vector;
        }
      `)
      );
      db = await cds.connect.to('cqn-vector-db', {
        kind: 'sqlite',
        credentials: { url: ':memory:' },
        model,
        embedding: { model: MINILM_MODEL, prompts: PROMPTS }
      });
      await db.run('CREATE TABLE EmbeddingDocuments (ID INTEGER, selected TEXT, fallback TEXT)');
      const embedding = runtime.vectorEmbedding(`${PROMPTS.query}${TEXT}`);
      await db.run(
        cds.ql.INSERT.into('EmbeddingDocuments').entries({
          ID: 1,
          selected: embedding,
          fallback: embedding
        })
      );
    });

    after(async () => {
      try {
        await db?.disconnect();
      } finally {
        cds.env.requires.embeddings = embeddings;
        if (selectedEmbeddings === undefined) delete cds.env.requires['selected-embeddings'];
        else cds.env.requires['selected-embeddings'] = selectedEmbeddings;
      }
    });

    test('defaults to QUERY without HANA configuration and keeps an explicit DOCUMENT prompt', async () => {
      assert.strictEqual(cds.env.requires.embeddings.model, undefined);
      const query = cds.ql.SELECT.from('EmbeddingDocuments').columns`
        vector_embedding(${TEXT}) as queryEmbedding,
        vector_embedding(${TEXT}, 'DOCUMENT') as documentEmbedding
      `;
      const { sql } = db.cqn2sql(query);
      assert.match(sql, /vector_embedding\(\?,'QUERY'\)/);
      assert.match(sql, /vector_embedding\(\?,\?\)/);

      const [row] = await db.run(query);
      assert.strictEqual(row.queryEmbedding, runtime.vectorEmbedding(`${PROMPTS.query}${TEXT}`));
      assert.strictEqual(
        row.documentEmbedding,
        runtime.vectorEmbedding(`${PROMPTS.document}${TEXT}`)
      );
      assert.notStrictEqual(row.queryEmbedding, row.documentEmbedding);
      assert.notStrictEqual(row.queryEmbedding, runtime.vectorEmbedding(TEXT));
      assert.strictEqual(JSON.parse(row.queryEmbedding).length, 384);
    });

    for (const expression of [
      "cosine_similarity(selected, vector_embedding('a small cat'))",
      "cosine_similarity(vector_embedding('a small cat'), selected)",
      "l2distance(selected, vector_embedding('a small cat'))",
      "l2distance(vector_embedding('a small cat'), selected)"
    ]) {
      test(`keeps the local query prompt regardless of model annotation for ${expression}`, async () => {
        const query = cds.parse.cql(`SELECT from EmbeddingDocuments { ${expression} as score }`);
        const { sql, values } = db.cqn2sql(query);
        assert.match(sql, /vector_embedding\(\?,'QUERY'\)/);
        assert.deepStrictEqual(values, [TEXT]);

        const [row] = await db.run(query);
        const expected = expression.startsWith('cosine_similarity') ? 1 : 0;
        assert.ok(Math.abs(row.score - expected) < 1e-6, `${expression}: ${row.score}`);
        assert.strictEqual(db.options.embedding.model, MINILM_MODEL);
      });
    }

    test('ignores global HANA configuration and preserves explicit model and remote-source arguments', async () => {
      const embeddings = cds.env.requires.embeddings;
      cds.env.requires.embeddings = { model: 'GLOBAL.HANA.MODEL', model_kind: 'embeddings' };
      try {
        const query = cds.ql.SELECT.from('EmbeddingDocuments').columns`
          cosine_similarity(fallback, vector_embedding(${TEXT})) as score,
          vector_embedding(${TEXT}, 'DOCUMENT', 'EXPLICIT.HANA.MODEL') as documentEmbedding,
          vector_embedding(${TEXT}, 'QUERY', 'EXPLICIT.HANA.MODEL', 'remote') as remoteEmbedding
        `;
        const { sql, values } = db.cqn2sql(query);
        assert.match(sql, /vector_embedding\(\?,'QUERY'\)/);
        assert.deepStrictEqual(values, [
          TEXT,
          TEXT,
          'DOCUMENT',
          'EXPLICIT.HANA.MODEL',
          TEXT,
          'QUERY',
          'EXPLICIT.HANA.MODEL',
          'remote'
        ]);

        const [row] = await db.run(query);
        assert.ok(Math.abs(row.score - 1) < 1e-6);
        assert.strictEqual(
          row.documentEmbedding,
          runtime.vectorEmbedding(`${PROMPTS.document}${TEXT}`)
        );
        assert.strictEqual(row.remoteEmbedding, runtime.vectorEmbedding(`${PROMPTS.query}${TEXT}`));
        assert.strictEqual(db.options.embedding.model, MINILM_MODEL);
      } finally {
        cds.env.requires.embeddings = embeddings;
      }
    });
  }
);

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
