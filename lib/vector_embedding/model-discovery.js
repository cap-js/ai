import { createHash } from 'crypto';

import { assertSafeRepository, validateModelDescriptor } from './model-utils.js';

const HUGGING_FACE_ORIGIN = 'https://huggingface.co';
const REQUIRED_ARTIFACTS = [
  { role: 'model', name: 'model.onnx', path: 'onnx/model.onnx' },
  { role: 'tokenizer', name: 'tokenizer.json', path: 'tokenizer.json' },
  {
    role: 'tokenizerConfig',
    name: 'tokenizer_config.json',
    path: 'tokenizer_config.json'
  },
  { role: 'auxiliary', name: 'config.json', path: 'config.json' }
];
const MODULES_FILE = 'modules.json';
const SENTENCE_CONFIG_FILE = 'sentence_bert_config.json';
const SUPPORTED_MODULES = new Set([
  'sentence_transformers.models.Transformer',
  'sentence_transformers.models.Pooling',
  'sentence_transformers.models.Normalize'
]);

async function discoverModel(repository, options = {}) {
  assertSafeRepository(repository);

  // prettier-ignore
  const fetchImpl = typeof options !== 'function' 
    ? (options.fetchImpl ?? globalThis.fetch) 
    : options;

  // TODO: Is this really necessary? Why check fetch?
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }

  const origin = typeof options === 'function' ? undefined : options.origin;
  const context = createContext(fetchImpl, origin);

  const modelInfo = await fetchModelInfo(context, repository);
  const revision = immutableRevision(modelInfo, repository);

  // TODO: What do we need siblings for? What even are siblings?
  const siblings = siblingMap(modelInfo, repository);

  const tokenizer = await fetchJsonFile(context, repository, revision, 'tokenizer.json');
  const tokenizerConfig = await fetchJsonFile(
    context,
    repository,
    revision,
    'tokenizer_config.json'
  );
  const config = await fetchJsonFile(context, repository, revision, 'config.json');

  const dimensions = positiveInteger(config.value.hidden_size);
  if (!dimensions) {
    throw new Error(`Cannot determine embedding dimensions from '${repository}/config.json'`);
  }

  const selected = REQUIRED_ARTIFACTS.map((artifact) => {
    const sibling = siblings.get(artifact.path);
    if (!sibling) {
      throw new Error(
        `Hugging Face model '${repository}' must contain the exact file '${artifact.path}'`
      );
    }
    return { ...artifact, sibling };
  });

  const externalData = [...siblings.values()]
    .filter(({ rfilename }) => /^onnx\/model\.onnx_data(?:$|[._-])/u.test(rfilename))
    .map((sibling) => ({
      role: 'auxiliary',
      name: sibling.rfilename.slice('onnx/'.length),
      path: sibling.rfilename,
      sibling
    }));

  if (usesExternalData(config.value) && externalData.length === 0) {
    throw new Error(
      `Hugging Face model '${repository}' declares external ONNX data but does not contain 'onnx/model.onnx_data'`
    );
  }

  selected.push(...externalData);

  const semantics = await discoverSentenceTransformerSemantics(
    context,
    repository,
    modelInfo,
    new Set()
  );

  const maxLength = minimumPositiveInteger([
    tokenizer.value?.truncation?.max_length,
    tokenizerConfig.value.max_length,
    semantics.maxLength,
    tokenizerConfig.value.model_max_length,
    config.value.max_position_embeddings
  ]);

  if (!maxLength) {
    throw new Error(`Cannot determine the maximum input length for '${repository}'`);
  }

  const knownFiles = new Map([
    ['tokenizer.json', tokenizer],
    ['tokenizer_config.json', tokenizerConfig],
    ['config.json', config]
  ]);

  const files = await Promise.all(
    selected.map(async ({ sibling, ...artifact }) => ({
      ...artifact,
      ...(await discoverFileIntegrity(
        context,
        repository,
        revision,
        sibling,
        knownFiles.get(artifact.path)
      ))
    }))
  );

  return validateModelDescriptor({
    repository,
    revision,
    dimensions,
    maxLength,
    files,
    output: {
      name: 'last_hidden_state',
      pooling: semantics.pooling,
      normalize: semantics.normalize
    }
  });
}

// TODO: Get rid of overkill mapping; If validation is REALLY necessary: Validate and throw early, don't have validation everywhere; get rid of redundant wrappers throughout the file
function createContext(fetchImpl, origin = HUGGING_FACE_ORIGIN) {
  if (typeof origin !== 'string' || !origin.trim()) {
    throw new TypeError('The Hugging Face origin must be a non-empty string');
  }
  return { fetchImpl, origin: origin.replace(/\/$/, ''), jsonFiles: new Map() };
}

function usesExternalData(config) {
  const value = config?.['transformers.js_config']?.use_external_data_format;
  return value === true || value?.['model.onnx'] === 1 || value?.['model.onnx'] === true;
}

async function fetchModelInfo(context, repository) {
  const url = `${context.origin}/api/models/${repositoryPath(repository)}?blobs=true`;
  const response = await checkedFetch(context, url);
  const value = await readJsonResponse(response, url);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Hugging Face model information for '${repository}'`);
  }
  return value;
}

function immutableRevision(modelInfo, repository) {
  if (typeof modelInfo.sha !== 'string' || !/^[a-fA-F0-9]{40,64}$/.test(modelInfo.sha)) {
    throw new Error(`Hugging Face did not return an immutable revision for '${repository}'`);
  }
  return modelInfo.sha.toLowerCase();
}

function siblingMap(modelInfo, repository) {
  if (!Array.isArray(modelInfo.siblings)) {
    throw new Error(`Hugging Face did not return a file list for '${repository}'`);
  }

  const siblings = new Map();
  for (const sibling of modelInfo.siblings) {
    if (typeof sibling?.rfilename !== 'string') continue;
    if (siblings.has(sibling.rfilename)) {
      throw new Error(`Hugging Face returned duplicate file '${sibling.rfilename}'`);
    }
    siblings.set(sibling.rfilename, sibling);
  }

  return siblings;
}

async function discoverSentenceTransformerSemantics(context, repository, modelInfo, visited) {
  if (visited.has(repository)) {
    throw new Error(`Circular Hugging Face base_model chain involving '${repository}'`);
  }

  visited.add(repository);

  const revision = immutableRevision(modelInfo, repository);
  const siblings = siblingMap(modelInfo, repository);
  if (siblings.has(MODULES_FILE)) {
    return readSentenceTransformerSemantics(context, repository, revision, siblings);
  }

  const baseModel = baseModelRepository(modelInfo.cardData?.base_model);
  if (!baseModel) {
    throw new Error(
      `Cannot determine pooling and normalization for '${repository}': no Sentence Transformers modules or unambiguous base_model metadata`
    );
  }

  assertSafeRepository(baseModel);

  const baseInfo = await fetchModelInfo(context, baseModel);
  return discoverSentenceTransformerSemantics(context, baseModel, baseInfo, visited);
}

async function readSentenceTransformerSemantics(context, repository, revision, siblings) {
  const modules = (await fetchJsonFile(context, repository, revision, MODULES_FILE)).value;
  if (!Array.isArray(modules)) {
    throw new Error(`Invalid Sentence Transformers modules in '${repository}/${MODULES_FILE}'`);
  }

  const supported = modules.filter(
    (module) => module && typeof module.type === 'string' && SUPPORTED_MODULES.has(module.type)
  );
  const expectedTypes = [
    'sentence_transformers.models.Transformer',
    'sentence_transformers.models.Pooling'
  ];
  if (supported.length === 3) expectedTypes.push('sentence_transformers.models.Normalize');
  if (
    supported.length < 2 ||
    supported.length > 3 ||
    supported.some((module, index) => module.type !== expectedTypes[index])
  ) {
    throw new Error(`Cannot determine an unambiguous pooling pipeline for '${repository}'`);
  }

  const poolingModule = supported[1];
  const poolingPath = moduleConfigPath(poolingModule, repository);
  if (!siblings.has(poolingPath)) {
    throw new Error(`Sentence Transformers pooling configuration '${poolingPath}' is missing`);
  }
  const poolingConfig = (await fetchJsonFile(context, repository, revision, poolingPath)).value;
  const pooling = determinePooling(poolingConfig, repository);

  let maxLength;
  const transformer = supported[0];
  const sentenceConfigPaths = [SENTENCE_CONFIG_FILE];
  if (transformer?.path) {
    sentenceConfigPaths.unshift(
      `${normalizedModulePath(transformer.path)}/${SENTENCE_CONFIG_FILE}`
    );
  }
  const sentenceConfigPath = sentenceConfigPaths.find((configPath) => siblings.has(configPath));
  if (sentenceConfigPath) {
    const sentenceConfig = await fetchJsonFile(context, repository, revision, sentenceConfigPath);
    maxLength = positiveInteger(sentenceConfig.value.max_seq_length);
  }

  return { pooling, normalize: supported.length === 3, maxLength };
}

function moduleConfigPath(module, repository) {
  const modulePath = normalizedModulePath(module.path);
  if (!modulePath) {
    throw new Error(`Sentence Transformers pooling module in '${repository}' has no path`);
  }
  return `${modulePath}/config.json`;
}

function normalizedModulePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return value;
}

function determinePooling(config, repository) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid Sentence Transformers pooling configuration for '${repository}'`);
  }

  const enabled = [
    ['cls', config.pooling_mode_cls_token],
    ['mean', config.pooling_mode_mean_tokens],
    ['max', config.pooling_mode_max_tokens],
    ['mean_sqrt_len', config.pooling_mode_mean_sqrt_len_tokens],
    ['weightedmean', config.pooling_mode_weightedmean_tokens],
    ['lasttoken', config.pooling_mode_lasttoken]
  ].filter(([, value]) => value === true);

  if (config.pooling_mode !== undefined) {
    if (!['mean', 'cls'].includes(config.pooling_mode)) {
      throw new Error(`Unsupported or ambiguous Sentence Transformers pooling for '${repository}'`);
    }
    if (enabled.length > 0 && (enabled.length !== 1 || enabled[0][0] !== config.pooling_mode)) {
      throw new Error(`Unsupported or ambiguous Sentence Transformers pooling for '${repository}'`);
    }
    return config.pooling_mode;
  }

  if (enabled.length !== 1 || !['mean', 'cls'].includes(enabled[0][0])) {
    throw new Error(`Unsupported or ambiguous Sentence Transformers pooling for '${repository}'`);
  }

  return enabled[0][0];
}

function baseModelRepository(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string') {
    return value.id;
  }

  return undefined;
}

async function discoverFileIntegrity(context, repository, revision, sibling, knownFile) {
  const metadataChecksum = lfsChecksum(sibling);
  const metadataSize = positiveInteger(sibling.size) ?? positiveInteger(sibling.lfs?.size);

  if (metadataChecksum && metadataSize) {
    return { size: metadataSize, sha256: metadataChecksum };
  }

  const file = knownFile ?? (await fetchFile(context, repository, revision, sibling.rfilename));
  return {
    size: file.bytes.byteLength,
    sha256: createHash('sha256').update(file.bytes).digest('hex')
  };
}

function lfsChecksum(sibling) {
  const candidate = sibling.lfs?.sha256 ?? sibling.lfs?.oid;
  if (typeof candidate !== 'string') return undefined;
  const checksum = candidate.replace(/^sha256:/, '').toLowerCase();

  return /^[a-f0-9]{64}$/.test(checksum) ? checksum : undefined;
}

async function fetchJsonFile(context, repository, revision, remotePath) {
  const key = `${repository}@${revision}/${remotePath}`;
  let file = context.jsonFiles.get(key);

  if (!file) {
    file = fetchFile(context, repository, revision, remotePath).then(({ bytes, url }) => {
      try {
        return { bytes, value: JSON.parse(bytes.toString('utf8')) };
      } catch (error) {
        throw new Error(`Invalid JSON returned from ${url}: ${error.message}`, { cause: error });
      }
    });
    context.jsonFiles.set(key, file);
  }

  return file;
}

async function fetchFile(context, repository, revision, remotePath) {
  const url = `${context.origin}/${repositoryPath(repository)}/resolve/${revision}/${remotePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const response = await checkedFetch(context, url);

  return { bytes: await readBytes(response), url };
}

async function checkedFetch(context, url) {
  let response;
  try {
    response = await context.fetchImpl(url);
  } catch (error) {
    throw new Error(`Cannot fetch ${url}: ${error.message}`, { cause: error });
  }

  if (!response || response.ok !== true) {
    throw new Error(`Cannot fetch ${url}: HTTP ${response?.status ?? 'unknown'}`);
  }

  return response;
}

async function readJsonResponse(response, url) {
  try {
    if (typeof response.json === 'function') return await response.json();
    return JSON.parse((await readBytes(response)).toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON returned from ${url}: ${error.message}`, { cause: error });
  }
}

async function readBytes(response) {
  if (typeof response.arrayBuffer === 'function') {
    return Buffer.from(await response.arrayBuffer());
  }
  if (typeof response.text === 'function') return Buffer.from(await response.text());
  throw new Error('Fetch response does not expose arrayBuffer() or text()');
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function minimumPositiveInteger(values) {
  const candidates = values.map(positiveInteger).filter((value) => value !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

function repositoryPath(repository) {
  return repository.split('/').map(encodeURIComponent).join('/');
}

const discoverModelDescriptor = discoverModel;

export { discoverModel, discoverModelDescriptor };
