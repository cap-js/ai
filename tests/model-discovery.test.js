import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, test } from 'node:test';

import { checkModel, discoverModel } from '../lib/vector_embedding/model-discovery.js';

const REVISION = '1'.repeat(40);
const BASE_REVISION = '2'.repeat(40);
const REPOSITORY = 'example/embedding-model';
const BASE_REPOSITORY = 'sentence-transformers/base-model';

describe('Hugging Face model discovery', () => {
  test('allows a missing Hub task while checking metadata without downloading ONNX', async () => {
    const hub = hubFor({ omitTask: true });

    const result = await checkModel(REPOSITORY, { hubClient: hub.client });

    assert.deepEqual(
      {
        repository: result.repository,
        revision: result.revision,
        task: result.task,
        dimensions: result.dimensions,
        maxLength: result.maxLength,
        files: result.files.map(({ role, name, path }) => ({ role, name, path })),
        output: result.output
      },
      {
        repository: REPOSITORY,
        revision: REVISION,
        task: undefined,
        dimensions: 384,
        maxLength: 96,
        files: [
          { role: 'model', name: 'model.onnx', path: 'onnx/model.onnx' },
          { role: 'tokenizer', name: 'tokenizer.json', path: 'tokenizer.json' },
          {
            role: 'tokenizerConfig',
            name: 'tokenizer_config.json',
            path: 'tokenizer_config.json'
          },
          { role: 'auxiliary', name: 'config.json', path: 'config.json' }
        ],
        output: { name: 'last_hidden_state', pooling: 'mean', normalize: true }
      }
    );
    assert.ok(
      hub.fileRequests.every(([, , remotePath]) => !remotePath.toLowerCase().endsWith('.onnx')),
      'the metadata-only check must not fetch ONNX bytes'
    );
  });

  test('creates a descriptor from a conventional Sentence Transformers ONNX repository', async () => {
    const hub = hubFor({
      tokenizer: { truncation: { max_length: 96 } },
      tokenizerConfig: { model_max_length: 128 },
      config: { hidden_size: 384, max_position_embeddings: 512 },
      sentenceConfig: { max_seq_length: 256 },
      normalize: true
    });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.equal(descriptor.repository, REPOSITORY);
    assert.equal(descriptor.revision, REVISION);
    assert.equal(descriptor.dimensions, 384);
    assert.equal(descriptor.maxLength, 96);
    assert.deepEqual(descriptor.output, {
      name: 'last_hidden_state',
      pooling: 'mean',
      normalize: true
    });
    assert.deepEqual(
      descriptor.files.map(({ role, name, path }) => ({ role, name, path })),
      [
        { role: 'model', name: 'model.onnx', path: 'onnx/model.onnx' },
        { role: 'tokenizer', name: 'tokenizer.json', path: 'tokenizer.json' },
        {
          role: 'tokenizerConfig',
          name: 'tokenizer_config.json',
          path: 'tokenizer_config.json'
        },
        { role: 'auxiliary', name: 'config.json', path: 'config.json' }
      ]
    );
    const tokenizerFile = descriptor.files.find(({ role }) => role === 'tokenizer');
    assert.equal(tokenizerFile.sha256, digest(hub.files[REPOSITORY]['tokenizer.json']));
    assert.equal(tokenizerFile.size, hub.files[REPOSITORY]['tokenizer.json'].length);
    assert.deepEqual(hub.fileLists, [[REPOSITORY, REVISION]]);
  });

  test('selects a unique nested export and adjacent tokenizer/configuration files', async () => {
    const hub = hubFor({
      modelPath: 'exports/encoder/model.onnx',
      assetDirectory: 'exports/encoder',
      tokenizer: { truncation: null },
      tokenizerConfig: { model_max_length: 1e30 },
      config: { d_model: 768, n_positions: 256 },
      sentenceConfig: undefined
    });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.equal(descriptor.dimensions, 768);
    assert.equal(descriptor.maxLength, 256);
    assert.deepEqual(
      descriptor.files.map(({ role, path }) => ({ role, path })),
      [
        { role: 'model', path: 'exports/encoder/model.onnx' },
        { role: 'tokenizer', path: 'exports/encoder/tokenizer.json' },
        { role: 'tokenizerConfig', path: 'exports/encoder/tokenizer_config.json' },
        { role: 'auxiliary', path: 'exports/encoder/config.json' }
      ]
    );
  });

  test('prefers metadata next to a nested ONNX export over repository-root files', async () => {
    const hub = hubFor({
      modelPath: 'exports/encoder/model.onnx',
      assetDirectory: 'exports/encoder',
      tokenizer: { truncation: { max_length: 96 } },
      config: { hidden_size: 768, max_position_embeddings: 256 },
      rootAssets: {
        tokenizer: { truncation: { max_length: 16 } },
        tokenizerConfig: { model_max_length: 16 },
        config: { hidden_size: 16, max_position_embeddings: 16 }
      }
    });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.equal(descriptor.dimensions, 768);
    assert.equal(descriptor.maxLength, 96);
    assert.ok(
      descriptor.files
        .filter(({ role }) => role !== 'model')
        .every(({ path }) => path.startsWith('exports/encoder/'))
    );
  });

  test('recognizes common Transformers dimension and sequence-limit aliases', async () => {
    await Promise.all(
      [
        [{ n_embd: 32, n_ctx: 1024 }, 32, 1024],
        [{ d_model: 64, n_positions: 768 }, 64, 768],
        [{ dim: 128, max_position_embeddings: 512 }, 128, 512]
      ].map(async ([config, expectedDimensions, expectedLength]) => {
        const hub = hubFor({
          tokenizer: { truncation: null },
          tokenizerConfig: { model_max_length: 1e30 },
          config,
          sentenceConfig: undefined
        });
        const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });
        assert.equal(descriptor.dimensions, expectedDimensions);
        assert.equal(descriptor.maxLength, expectedLength);
      })
    );

    const conflicting = hubFor({
      config: { hidden_size: 384, d_model: 768, max_position_embeddings: 512 }
    });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: conflicting.client }),
      /Conflicting embedding dimensions/
    );
  });

  test('ignores generic tokenizer max_length when determining the model input window', async () => {
    const hub = hubFor({
      tokenizer: { truncation: null },
      tokenizerConfig: { max_length: 32, model_max_length: 128 },
      config: { hidden_size: 384, max_position_embeddings: 512 },
      sentenceConfig: undefined
    });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.equal(descriptor.maxLength, 128);
  });

  test('follows a pinned base_model for Sentence Transformers semantics', async () => {
    const hub = hubFor({
      tokenizer: { truncation: null },
      tokenizerConfig: { model_max_length: 128 },
      config: { hidden_size: 768, max_position_embeddings: 512 },
      modules: false,
      baseModel: BASE_REPOSITORY
    });
    hub.addBaseModel({
      sentenceConfig: { max_seq_length: 64 },
      pooling: 'cls',
      normalize: false
    });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.equal(descriptor.maxLength, 64);
    assert.equal(descriptor.output.pooling, 'cls');
    assert.equal(descriptor.output.normalize, false);
    assert.ok(hub.modelInfos.includes(BASE_REPOSITORY));
    assert.ok(
      hub.fileRequests.some(
        ([repository, revision, remotePath]) =>
          repository === BASE_REPOSITORY &&
          revision === BASE_REVISION &&
          remotePath === 'modules.json'
      )
    );
  });

  test('includes external ONNX data files next to the selected model', async () => {
    const hub = hubFor({ externalData: true });
    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.deepEqual(
      descriptor.files.find(({ path }) => path === 'onnx/model.onnx_data'),
      {
        role: 'auxiliary',
        name: 'model.onnx_data',
        path: 'onnx/model.onnx_data',
        size: hub.files[REPOSITORY]['onnx/model.onnx_data'].length,
        sha256: digest(hub.files[REPOSITORY]['onnx/model.onnx_data'])
      }
    );
  });

  test('rejects arbitrary sidecars when external ONNX data is declared', async () => {
    const hub = hubFor({ externalData: 'weights.bin' });

    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: hub.client }),
      /declares external ONNX data but no data file exists/
    );
  });

  test('rejects incompatible Hugging Face tasks before downloading artifacts', async () => {
    await Promise.all(
      [
        ['text-generation', 'openai-community/gpt2'],
        ['fill-mask', 'FacebookAI/xlm-roberta-base']
      ].map(async ([task, repository]) => {
        const hub = createHub({
          [repository]: { info: { sha: REVISION, task }, files: {} }
        });
        await assert.rejects(
          discoverModel(repository, { hubClient: hub.client }),
          new RegExp(`declares task '${task}', not an embedding task`)
        );
        assert.deepEqual(hub.fileLists, []);
      })
    );
  });

  test('rejects ambiguous ONNX exports and ambiguous Sentence Transformers semantics', async () => {
    const ambiguousModel = hubFor({
      modelPath: 'exports/encoder.onnx',
      assetDirectory: 'exports',
      additionalOnnxPath: 'other/encoder.onnx'
    });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: ambiguousModel.client }),
      /ambiguous ONNX exports/
    );

    const ambiguousPooling = hubFor({ pooling: ['mean', 'cls'] });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: ambiguousPooling.client }),
      /Unsupported or ambiguous Sentence Transformers pooling/
    );

    const invalidOrder = hubFor({ moduleOrder: ['Pooling', 'Transformer'] });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: invalidOrder.client }),
      /unambiguous pooling pipeline/
    );

    const unsupportedStage = hubFor({ moduleOrder: ['Transformer', 'Pooling', 'Dense'] });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: unsupportedStage.client }),
      /Unsupported Sentence Transformers module 'sentence_transformers.models.Dense'/
    );
  });

  test('downloads an artifact to derive integrity when file metadata has no checksum', async () => {
    const hub = hubFor({ modelMetadata: false });
    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });
    const model = descriptor.files.find(({ role }) => role === 'model');
    const contents = hub.files[REPOSITORY]['onnx/model.onnx'];
    assert.equal(model.size, contents.length);
    assert.equal(model.sha256, digest(contents));
  });

  test('should map sentence-transformers query and passage prompts onto HANA text types', async () => {
    const hub = hubFor({
      stConfig: { prompts: { query: 'query: ', passage: 'passage: ' }, default_prompt_name: null }
    });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.deepEqual(descriptor.prompts, { query: 'query: ', document: 'passage: ' });
  });

  test('should keep a query-only prompt without inventing a document prefix', async () => {
    const hub = hubFor({ stConfig: { prompts: { query: 'query: ' } } });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.deepEqual(descriptor.prompts, { query: 'query: ' });
  });

  test('should treat an empty document/passage prompt as no prefix', async () => {
    const hub = hubFor({ stConfig: { prompts: { query: 'query: ', passage: '' } } });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.deepEqual(descriptor.prompts, { query: 'query: ' });
  });

  test('should omit prompts when the model declares none', async () => {
    const hub = hubFor({ stConfig: { max_seq_length: 256 } });

    const descriptor = await discoverModel(REPOSITORY, { hubClient: hub.client });

    assert.equal(descriptor.prompts, undefined);
  });

  test('should reject models with prompts that exclude prompt tokens from pooling', async () => {
    const hub = hubFor({ stConfig: { prompts: { query: 'query: ' } }, includePrompt: false });

    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: hub.client }),
      /include_prompt=false/
    );
  });

  test('shouold reject prompt shapes that cannot be mapped to HANA text types', async () => {
    const unknownKey = hubFor({ stConfig: { prompts: { classification: 'Classify: ' } } });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: unknownKey.client }),
      /Unsupported Sentence Transformers prompt 'classification'/
    );

    const conflicting = hubFor({
      stConfig: { prompts: { document: 'doc: ', passage: 'passage: ' } }
    });
    await assert.rejects(
      discoverModel(REPOSITORY, { hubClient: conflicting.client }),
      /Conflicting Sentence Transformers 'document' and 'passage' prompts/
    );
  });
});

function hubFor(options = {}) {
  const modelPath = options.modelPath ?? 'onnx/model.onnx';
  const assetDirectory = options.assetDirectory ?? '';
  const asset = (name) => (assetDirectory ? `${assetDirectory}/${name}` : name);
  const files = {
    [modelPath]: Buffer.from('fake onnx model'),
    [asset('tokenizer.json')]: json(options.tokenizer ?? { truncation: { max_length: 96 } }),
    [asset('tokenizer_config.json')]: json(options.tokenizerConfig ?? { model_max_length: 128 }),
    [asset('config.json')]: json(
      options.config ?? { hidden_size: 384, max_position_embeddings: 512 }
    )
  };
  if (options.rootAssets) {
    files['tokenizer.json'] = json(options.rootAssets.tokenizer);
    files['tokenizer_config.json'] = json(options.rootAssets.tokenizerConfig);
    files['config.json'] = json(options.rootAssets.config);
  }
  if (options.externalData) {
    const dataPath =
      options.externalData === true
        ? `${modelPath}_data`
        : `${path.posix.dirname(modelPath)}/${options.externalData}`;
    files[dataPath] = Buffer.from('external weights');
    const config = JSON.parse(files[asset('config.json')].toString());
    config['transformers.js_config'] = { use_external_data_format: { [modelPath]: 1 } };
    files[asset('config.json')] = json(config);
  }
  if (options.additionalOnnxPath) files[options.additionalOnnxPath] = Buffer.from('another model');

  if (options.modules !== false) {
    const moduleTypes = options.moduleOrder ?? [
      'Transformer',
      'Pooling',
      ...(options.normalize === false ? [] : ['Normalize'])
    ];
    files['modules.json'] = json(
      moduleTypes.map((type, index) => ({
        idx: index,
        name: String(index),
        path: type === 'Pooling' ? '1_Pooling' : '',
        type: `sentence_transformers.models.${type}`
      }))
    );
    files['1_Pooling/config.json'] = json(
      poolingConfig(options.pooling ?? 'mean', options.includePrompt)
    );
    if (options.sentenceConfig !== undefined) {
      files['sentence_bert_config.json'] = json(options.sentenceConfig);
    } else if (!Object.hasOwn(options, 'sentenceConfig')) {
      files['sentence_bert_config.json'] = json({ max_seq_length: 256 });
    }
    if (options.stConfig !== undefined) {
      files['config_sentence_transformers.json'] = json(options.stConfig);
    }
  }

  const info = {
    sha: REVISION,
    ...(!options.omitTask ? { task: options.task ?? 'sentence-similarity' } : {}),
    ...(options.baseModel ? { cardData: { base_model: options.baseModel } } : {})
  };
  const hub = createHub({
    [REPOSITORY]: { info, files, modelMetadata: options.modelMetadata }
  });
  hub.addBaseModel = (baseOptions = {}) => {
    const baseFiles = {
      'modules.json': json([
        { idx: 0, path: '', type: 'sentence_transformers.models.Transformer' },
        { idx: 1, path: '1_Pooling', type: 'sentence_transformers.models.Pooling' },
        ...(baseOptions.normalize
          ? [{ idx: 2, path: '2_Normalize', type: 'sentence_transformers.models.Normalize' }]
          : [])
      ]),
      '1_Pooling/config.json': json(poolingConfig(baseOptions.pooling ?? 'mean')),
      'sentence_bert_config.json': json(baseOptions.sentenceConfig ?? { max_seq_length: 128 })
    };
    hub.add(BASE_REPOSITORY, { info: { sha: BASE_REVISION }, files: baseFiles });
  };
  return hub;
}

function createHub(repositories) {
  const modelInfos = [];
  const fileLists = [];
  const fileRequests = [];
  const client = {
    async getModelInfo(repository) {
      modelInfos.push(repository);
      const entry = repositories[repository];
      if (!entry) throw new Error(`Unknown test repository ${repository}`);
      return entry.info;
    },
    async getFiles(repository, revision) {
      fileLists.push([repository, revision]);
      const entry = repositories[repository];
      if (!entry) throw new Error(`Unknown test repository ${repository}`);
      return Object.entries(entry.files).map(([path, contents]) => ({
        path,
        ...(path.endsWith('.onnx') && entry.modelMetadata !== false
          ? { size: contents.length, lfs: { size: contents.length, sha256: digest(contents) } }
          : {})
      }));
    },
    async getFile(repository, revision, remotePath) {
      fileRequests.push([repository, revision, remotePath]);
      const contents = repositories[repository]?.files[remotePath];
      if (!contents) throw new Error(`Unknown test artifact ${repository}/${remotePath}`);
      return contents;
    }
  };
  return {
    client,
    files: Object.fromEntries(
      Object.entries(repositories).map(([name, entry]) => [name, entry.files])
    ),
    modelInfos,
    fileLists,
    fileRequests,
    add(repository, entry) {
      repositories[repository] = entry;
      this.files[repository] = entry.files;
    }
  };
}

function poolingConfig(pooling, includePrompt) {
  const enabled = Array.isArray(pooling) ? pooling : [pooling];
  return {
    pooling_mode_cls_token: enabled.includes('cls'),
    pooling_mode_mean_tokens: enabled.includes('mean'),
    pooling_mode_max_tokens: false,
    pooling_mode_mean_sqrt_len_tokens: false,
    pooling_mode_weightedmean_tokens: false,
    pooling_mode_lasttoken: false,
    ...(typeof includePrompt === 'boolean' ? { include_prompt: includePrompt } : {})
  };
}

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
