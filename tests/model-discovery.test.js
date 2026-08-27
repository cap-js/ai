import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { discoverModel } from '../lib/vector_embedding/model-discovery.js';

const REVISION = '1'.repeat(40);
const BASE_REVISION = '2'.repeat(40);
const REPOSITORY = 'example/embedding-model';
const BASE_REPOSITORY = 'sentence-transformers/base-model';

describe('Hugging Face model discovery', () => {
  test('creates a validated descriptor from exact artifacts and Sentence Transformers metadata', async () => {
    const routes = modelRoutes({
      tokenizer: { truncation: { max_length: 96 } },
      tokenizerConfig: { model_max_length: 128 },
      config: { hidden_size: 384, max_position_embeddings: 512 },
      sentenceConfig: { max_seq_length: 256 },
      normalize: true
    });

    const descriptor = await discoverModel(REPOSITORY, { fetchImpl: createFetch(routes) });

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
    assert.equal(
      tokenizerFile.sha256,
      digest(routes[fileUrl(REPOSITORY, REVISION, 'tokenizer.json')])
    );
    assert.equal(
      tokenizerFile.size,
      routes[fileUrl(REPOSITORY, REVISION, 'tokenizer.json')].length
    );
  });

  test('follows a pinned base_model for semantics and Sentence Transformers max length', async () => {
    const routes = modelRoutes({
      tokenizer: { truncation: null },
      tokenizerConfig: { model_max_length: 128 },
      config: { hidden_size: 768, max_position_embeddings: 512 },
      modules: false,
      baseModel: BASE_REPOSITORY
    });
    addBaseModelRoutes(routes, {
      sentenceConfig: { max_seq_length: 64 },
      pooling: 'cls',
      normalize: false
    });

    const requested = [];
    const descriptor = await discoverModel(REPOSITORY, {
      fetchImpl: createFetch(routes, requested)
    });

    assert.equal(descriptor.maxLength, 64);
    assert.equal(descriptor.output.pooling, 'cls');
    assert.equal(descriptor.output.normalize, false);
    assert.ok(
      requested.includes(apiUrl(BASE_REPOSITORY)),
      'the base repository is resolved through the model API'
    );
    assert.ok(
      requested.some((url) => url.includes(`/resolve/${BASE_REVISION}/modules.json`)),
      'base-model metadata is read from its immutable revision'
    );
  });

  test('falls back from tokenizer configuration to model configuration for max length', async () => {
    const tokenizerRoutes = modelRoutes({
      tokenizer: { truncation: null },
      tokenizerConfig: { model_max_length: 192 },
      config: { hidden_size: 32, max_position_embeddings: 256 },
      sentenceConfig: undefined
    });
    assert.equal(
      (await discoverModel(REPOSITORY, { fetchImpl: createFetch(tokenizerRoutes) })).maxLength,
      192
    );

    const configRoutes = modelRoutes({
      tokenizer: { truncation: null },
      tokenizerConfig: { model_max_length: 1e30 },
      config: { hidden_size: 32, max_position_embeddings: 256 },
      sentenceConfig: undefined
    });
    assert.equal(
      (await discoverModel(REPOSITORY, { fetchImpl: createFetch(configRoutes) })).maxLength,
      256
    );
  });

  test('uses the lowest declared tokenizer and model input limit', async () => {
    const routes = modelRoutes({
      tokenizer: { truncation: null },
      tokenizerConfig: { max_length: 128, model_max_length: 512 },
      config: { hidden_size: 32, max_position_embeddings: 256 },
      sentenceConfig: { max_seq_length: 384 }
    });

    assert.equal(
      (await discoverModel(REPOSITORY, { fetchImpl: createFetch(routes) })).maxLength,
      128
    );
  });

  test('includes external ONNX data files', async () => {
    const routes = modelRoutes({ externalData: true });
    const descriptor = await discoverModel(REPOSITORY, { fetchImpl: createFetch(routes) });

    assert.deepEqual(
      descriptor.files.find(({ path }) => path === 'onnx/model.onnx_data'),
      {
        role: 'auxiliary',
        name: 'model.onnx_data',
        path: 'onnx/model.onnx_data',
        size: routes[fileUrl(REPOSITORY, REVISION, 'onnx/model.onnx_data')].length,
        sha256: digest(routes[fileUrl(REPOSITORY, REVISION, 'onnx/model.onnx_data')])
      }
    );
  });

  test('rejects missing exact artifacts and ambiguous runtime semantics', async () => {
    const missing = modelRoutes({});
    const info = JSON.parse(missing[apiUrl(REPOSITORY)].toString());
    info.siblings = info.siblings.filter(({ rfilename }) => rfilename !== 'onnx/model.onnx');
    missing[apiUrl(REPOSITORY)] = json(info);
    await assert.rejects(
      discoverModel(REPOSITORY, { fetchImpl: createFetch(missing) }),
      /exact file 'onnx\/model\.onnx'/
    );

    const ambiguous = modelRoutes({ pooling: ['mean', 'cls'] });
    await assert.rejects(
      discoverModel(REPOSITORY, { fetchImpl: createFetch(ambiguous) }),
      /Unsupported or ambiguous Sentence Transformers pooling/
    );

    const invalidOrder = modelRoutes({ moduleOrder: ['Pooling', 'Transformer'] });
    await assert.rejects(
      discoverModel(REPOSITORY, { fetchImpl: createFetch(invalidOrder) }),
      /unambiguous pooling pipeline/
    );

    const conflicting = modelRoutes({ pooling: 'mean', poolingMode: 'cls' });
    await assert.rejects(
      discoverModel(REPOSITORY, { fetchImpl: createFetch(conflicting) }),
      /Unsupported or ambiguous Sentence Transformers pooling/
    );
  });

  test('downloads an artifact to derive integrity when Hugging Face has no LFS metadata', async () => {
    const routes = modelRoutes({ modelMetadata: false });
    const descriptor = await discoverModel(REPOSITORY, createFetch(routes));
    const model = descriptor.files.find(({ role }) => role === 'model');
    const contents = routes[fileUrl(REPOSITORY, REVISION, 'onnx/model.onnx')];
    assert.equal(model.size, contents.length);
    assert.equal(model.sha256, digest(contents));
  });
});

function modelRoutes(options = {}) {
  const tokenizer = json(options.tokenizer ?? { truncation: { max_length: 96 } });
  const tokenizerConfig = json(options.tokenizerConfig ?? { model_max_length: 128 });
  const configValue = options.config ?? { hidden_size: 384, max_position_embeddings: 512 };
  if (options.externalData) {
    configValue['transformers.js_config'] = {
      use_external_data_format: { 'model.onnx': 1 }
    };
  }
  const config = json(configValue);
  const model = Buffer.from('fake onnx model');
  const moduleTypes = options.moduleOrder ?? [
    'Transformer',
    'Pooling',
    ...(options.normalize === false ? [] : ['Normalize'])
  ];
  const modules = json(
    moduleTypes.map((type, index) => ({
      idx: index,
      name: String(index),
      path: type === 'Pooling' ? '1_Pooling' : '',
      type: `sentence_transformers.models.${type}`
    }))
  );
  const pooling = json(poolingConfig(options.pooling ?? 'mean', options.poolingMode));
  const files = {
    'onnx/model.onnx': model,
    'tokenizer.json': tokenizer,
    'tokenizer_config.json': tokenizerConfig,
    'config.json': config
  };
  if (options.externalData) files['onnx/model.onnx_data'] = Buffer.from('external weights');
  if (options.modules !== false) {
    files['modules.json'] = modules;
    files['1_Pooling/config.json'] = pooling;
    if (options.sentenceConfig !== undefined) {
      files['sentence_bert_config.json'] = json(options.sentenceConfig);
    } else if (!Object.hasOwn(options, 'sentenceConfig')) {
      files['sentence_bert_config.json'] = json({ max_seq_length: 256 });
    }
  }
  const siblings = Object.entries(files).map(([rfilename, contents]) => ({
    rfilename,
    ...(rfilename === 'onnx/model.onnx' && options.modelMetadata !== false
      ? { size: contents.length, lfs: { size: contents.length, sha256: digest(contents) } }
      : {})
  }));
  return {
    [apiUrl(REPOSITORY)]: json({
      sha: REVISION,
      siblings,
      ...(options.baseModel ? { cardData: { base_model: options.baseModel } } : {})
    }),
    ...Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [
        fileUrl(REPOSITORY, REVISION, name),
        contents
      ])
    )
  };
}

function addBaseModelRoutes(routes, options = {}) {
  const modules = json([
    {
      idx: 0,
      path: '',
      type: 'sentence_transformers.models.Transformer'
    },
    {
      idx: 1,
      path: '1_Pooling',
      type: 'sentence_transformers.models.Pooling'
    },
    ...(options.normalize
      ? [{ idx: 2, path: '2_Normalize', type: 'sentence_transformers.models.Normalize' }]
      : [])
  ]);
  const pooling = json(poolingConfig(options.pooling ?? 'mean'));
  const sentenceConfig = json(options.sentenceConfig ?? { max_seq_length: 128 });
  const files = {
    'modules.json': modules,
    '1_Pooling/config.json': pooling,
    'sentence_bert_config.json': sentenceConfig
  };
  routes[apiUrl(BASE_REPOSITORY)] = json({
    sha: BASE_REVISION,
    siblings: Object.keys(files).map((rfilename) => ({ rfilename }))
  });
  for (const [name, contents] of Object.entries(files)) {
    routes[fileUrl(BASE_REPOSITORY, BASE_REVISION, name)] = contents;
  }
}

function poolingConfig(pooling, poolingMode) {
  const enabled = Array.isArray(pooling) ? pooling : [pooling];
  return {
    ...(poolingMode ? { pooling_mode: poolingMode } : {}),
    pooling_mode_cls_token: enabled.includes('cls'),
    pooling_mode_mean_tokens: enabled.includes('mean'),
    pooling_mode_max_tokens: enabled.includes('max'),
    pooling_mode_mean_sqrt_len_tokens: false,
    pooling_mode_weightedmean_tokens: false,
    pooling_mode_lasttoken: false
  };
}

function createFetch(routes, requested = []) {
  return async (input) => {
    const url = String(input);
    requested.push(url);
    const contents = routes[url];
    if (!contents) return response(Buffer.alloc(0), 404);
    return response(contents, 200);
  };
}

function response(contents, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(contents.toString());
    },
    async arrayBuffer() {
      return contents;
    }
  };
}

function apiUrl(repository) {
  return `https://huggingface.co/api/models/${repository}?blobs=true`;
}

function fileUrl(repository, revision, name) {
  return `https://huggingface.co/${repository}/resolve/${revision}/${name}`;
}

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
