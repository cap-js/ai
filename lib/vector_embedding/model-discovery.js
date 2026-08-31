import { createHash } from 'node:crypto';
import path from 'node:path';

import { createHuggingFaceClient } from './huggingface-hub.js';
import { assertSafeRepository, validateModelDescriptor } from './model-utils.js';

const MODULES_FILE = 'modules.json';
const SENTENCE_CONFIG_FILE = 'sentence_bert_config.json';
const EMBEDDING_TASKS = new Set(['feature-extraction', 'sentence-similarity']);
const PIPELINE_MODULES = new Set([
  'sentence_transformers.models.Transformer',
  'sentence_transformers.models.Pooling',
  'sentence_transformers.models.Normalize'
]);

// Modules that post-process output format only and do not affect the
// Transformer → Pooling → Normalize inference pipeline.
const TRANSPARENT_MODULE_NAMESPACES = [
  /^sentence_transformers\.quantization\./,
  /^st_quantize\./
];

function isTransparentModule(type) {
  return TRANSPARENT_MODULE_NAMESPACES.some((pattern) => pattern.test(type));
}

async function discoverModel(repository, options = {}) {
  const { candidate, context, filesByPath, knownFiles } = await discoverModelMetadata(
    repository,
    options
  );
  const descriptor = { ...candidate };
  delete descriptor.task;
  const descriptorFiles = await Promise.all(
    candidate.files.map(async (entry) => ({
      ...entry,
      ...(await discoverFileIntegrity(
        context,
        repository,
        candidate.revision,
        filesByPath.get(entry.path),
        knownFiles.get(entry.path)
      ))
    }))
  );

  return validateModelDescriptor({ ...descriptor, files: descriptorFiles });
}

async function checkModel(repository, options = {}) {
  const { candidate } = await discoverModelMetadata(repository, options);
  return candidate;
}

async function discoverModelMetadata(repository, options) {
  assertSafeRepository(repository);
  const normalizedOptions = typeof options === 'function' ? { fetchImpl: options } : options;
  const hubClient = normalizedOptions.hubClient ?? createHuggingFaceClient(normalizedOptions);
  const context = { hubClient, fileLists: new Map(), jsonFiles: new Map() };
  const modelInfo = await hubClient.getModelInfo(repository);
  rejectNonEmbeddingTask(modelInfo, repository);
  const task = modelTask(modelInfo);

  const revision = immutableRevision(modelInfo, repository);
  const filesByPath = await repositoryFiles(context, repository, revision);
  const modelPath = selectOnnxModel(filesByPath, repository);
  const tokenizerPath = selectCompanionFile(filesByPath, modelPath, 'tokenizer.json', repository);
  const tokenizerConfigPath = selectCompanionFile(
    filesByPath,
    modelPath,
    'tokenizer_config.json',
    repository
  );
  const configPath = selectCompanionFile(filesByPath, modelPath, 'config.json', repository);

  const [tokenizer, tokenizerConfig, config] = await Promise.all([
    fetchJsonFile(context, repository, revision, tokenizerPath),
    fetchJsonFile(context, repository, revision, tokenizerConfigPath),
    fetchJsonFile(context, repository, revision, configPath)
  ]);
  const dimensions = uniquePositiveInteger(
    [config.value.hidden_size, config.value.n_embd, config.value.d_model, config.value.dim],
    repository,
    configPath
  );
  if (!dimensions) {
    throw new Error(
      `Cannot determine embedding dimensions from '${repository}/${configPath}' (expected hidden_size, n_embd, d_model, or dim)`
    );
  }

  const semantics = await discoverSentenceTransformerSemantics(
    context,
    repository,
    modelInfo,
    new Set()
  );
  const maxLength = minimumPositiveInteger([
    tokenizer.value?.truncation?.max_length,
    semantics.maxLength,
    tokenizerConfig.value.model_max_length,
    config.value.max_position_embeddings,
    config.value.n_positions,
    config.value.n_ctx
  ]);
  if (!maxLength) {
    throw new Error(`Cannot determine the maximum input length for '${repository}'`);
  }

  const selected = [
    artifact('model', modelPath, modelPath),
    artifact('tokenizer', tokenizerPath, modelPath),
    artifact('tokenizerConfig', tokenizerConfigPath, modelPath),
    artifact('auxiliary', configPath, modelPath)
  ];
  const externalData = [...filesByPath.values()]
    .filter((file) => isExternalDataFile(file.path, modelPath))
    .map((file) => artifact('auxiliary', file.path, modelPath));
  if (usesExternalData(config.value, modelPath) && externalData.length === 0) {
    throw new Error(
      `Hugging Face model '${repository}' declares external ONNX data but no data file exists next to '${modelPath}'`
    );
  }
  selected.push(...externalData);

  const knownFiles = new Map([
    [tokenizerPath, tokenizer],
    [tokenizerConfigPath, tokenizerConfig],
    [configPath, config]
  ]);
  const candidate = validateModelCandidate({
    repository,
    revision,
    task,
    dimensions,
    maxLength,
    files: selected,
    output: {
      name: 'last_hidden_state',
      pooling: semantics.pooling,
      normalize: semantics.normalize
    }
  });
  return {
    context,
    filesByPath,
    knownFiles,
    candidate
  };
}

function validateModelCandidate(candidate) {
  validateModelDescriptor({
    ...candidate,
    files: candidate.files.map((file) => ({
      ...file,
      size: 1,
      sha256: '0'.repeat(64)
    }))
  });
  return candidate;
}

function rejectNonEmbeddingTask(modelInfo, repository) {
  const task = modelTask(modelInfo);
  if (typeof task === 'string' && task && !EMBEDDING_TASKS.has(task)) {
    throw new Error(
      `Hugging Face model '${repository}' declares task '${task}', not an embedding task`
    );
  }
}

function modelTask(modelInfo) {
  return modelInfo?.task;
}

function immutableRevision(modelInfo, repository) {
  if (typeof modelInfo?.sha !== 'string' || !/^[a-fA-F0-9]{40,64}$/.test(modelInfo.sha)) {
    throw new Error(`Hugging Face did not return an immutable revision for '${repository}'`);
  }
  return modelInfo.sha.toLowerCase();
}

function fileMap(files, repository) {
  if (!Array.isArray(files)) {
    throw new Error(`Hugging Face did not return a file list for '${repository}'`);
  }
  const result = new Map();
  for (const file of files) {
    const remotePath = file?.path ?? file?.rfilename;
    if (typeof remotePath !== 'string') continue;
    if (result.has(remotePath)) {
      throw new Error(`Hugging Face returned duplicate file '${remotePath}'`);
    }
    result.set(remotePath, { ...file, path: remotePath });
  }
  return result;
}

function selectOnnxModel(filesByPath, repository) {
  const paths = [...filesByPath.keys()].filter((remotePath) =>
    remotePath.toLowerCase().endsWith('.onnx')
  );
  if (paths.includes('onnx/model.onnx')) return 'onnx/model.onnx';
  if (paths.includes('model.onnx')) return 'model.onnx';

  const conventional = paths.filter(
    (remotePath) => path.posix.basename(remotePath).toLowerCase() === 'model.onnx'
  );
  if (conventional.length === 1) return conventional[0];
  if (conventional.length > 1 || paths.length > 1) {
    throw new Error(
      `Hugging Face model '${repository}' contains ambiguous ONNX exports: ${paths.join(', ')}`
    );
  }
  if (paths.length === 1) return paths[0];
  throw new Error(`Hugging Face model '${repository}' does not contain an ONNX model`);
}

function selectCompanionFile(filesByPath, modelPath, filename, repository) {
  const modelDirectory = path.posix.dirname(modelPath);
  const adjacent = modelDirectory === '.' ? filename : `${modelDirectory}/${filename}`;
  if (filesByPath.has(adjacent)) return adjacent;
  if (filesByPath.has(filename)) return filename;
  throw new Error(
    `Hugging Face model '${repository}' must contain '${filename}' at the repository root or next to '${modelPath}'`
  );
}

function artifact(role, remotePath, modelPath) {
  const modelDirectory = path.posix.dirname(modelPath);
  const name =
    role === 'auxiliary' && isExternalDataFile(remotePath, modelPath)
      ? path.posix.relative(modelDirectory, remotePath)
      : path.posix.basename(remotePath);
  return { role, name, path: remotePath };
}

function isExternalDataFile(remotePath, modelPath) {
  if (path.posix.dirname(remotePath) !== path.posix.dirname(modelPath)) return false;
  const name = path.posix.basename(remotePath);
  const modelName = path.posix.basename(modelPath);
  return (
    name.startsWith(`${modelName}_data`) ||
    name === `${modelName}.data` ||
    name.startsWith(`${modelName}.data.`)
  );
}

function usesExternalData(config, modelPath) {
  const value = config?.['transformers.js_config']?.use_external_data_format;
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = new Set([modelPath, path.posix.basename(modelPath)]);
  return Object.entries(value).some(
    ([name, enabled]) => names.has(name) && (enabled === true || enabled === 1)
  );
}

async function discoverSentenceTransformerSemantics(context, repository, modelInfo, visited) {
  if (visited.has(repository)) {
    throw new Error(`Circular Hugging Face base_model chain involving '${repository}'`);
  }
  visited.add(repository);

  const revision = immutableRevision(modelInfo, repository);
  const filesByPath = await repositoryFiles(context, repository, revision);
  if (filesByPath.has(MODULES_FILE)) {
    return readSentenceTransformerSemantics(context, repository, revision, filesByPath);
  }

  const baseModel = baseModelRepository(modelInfo.cardData?.base_model);
  if (!baseModel) {
    throw new Error(
      `Cannot determine pooling and normalization for '${repository}': no Sentence Transformers modules or unambiguous base_model metadata`
    );
  }
  assertSafeRepository(baseModel);
  const baseInfo = await context.hubClient.getModelInfo(baseModel);
  return discoverSentenceTransformerSemantics(context, baseModel, baseInfo, visited);
}

async function readSentenceTransformerSemantics(context, repository, revision, filesByPath) {
  const modules = (await fetchJsonFile(context, repository, revision, MODULES_FILE)).value;
  if (!Array.isArray(modules)) {
    throw new Error(`Invalid Sentence Transformers modules in '${repository}/${MODULES_FILE}'`);
  }

  // modules.json defines the ordered execution pipeline. Skipping a module that changes the
  // semantic content of the embedding would silently produce incompatible vectors. Modules in
  // TRANSPARENT_MODULES only post-process output format (e.g. quantization) and are safe to
  // omit when float32 cosine similarity is the downstream search metric.
  for (const module of modules) {
    if (!module || typeof module.type !== 'string') throw new Error(
      `Invalid Sentence Transformers module in '${repository}/${MODULES_FILE}'`
    )
    if (!PIPELINE_MODULES.has(module.type) && !isTransparentModule(module.type)) {
      throw new Error(`Unsupported Sentence Transformers module '${module.type}' in '${repository}'`);
    }
  }
  const pipeline = modules.filter((module) => PIPELINE_MODULES.has(module.type));
  const expectedTypes = [
    'sentence_transformers.models.Transformer',
    'sentence_transformers.models.Pooling'
  ];
  if (pipeline.length === 3) expectedTypes.push('sentence_transformers.models.Normalize');
  if (
    pipeline.length < 2 ||
    pipeline.length > 3 ||
    pipeline.some((module, index) => module.type !== expectedTypes[index])
  ) {
    throw new Error(`Cannot determine an unambiguous pooling pipeline for '${repository}'`);
  }

  const poolingPath = moduleConfigPath(pipeline[1], repository);
  if (!filesByPath.has(poolingPath)) {
    throw new Error(`Sentence Transformers pooling configuration '${poolingPath}' is missing`);
  }
  const poolingConfig = (await fetchJsonFile(context, repository, revision, poolingPath)).value;
  const pooling = determinePooling(poolingConfig, repository);

  let maxLength;
  const sentenceConfigPaths = [SENTENCE_CONFIG_FILE];
  if (pipeline[0]?.path) {
    sentenceConfigPaths.unshift(`${normalizedModulePath(pipeline[0].path)}/${SENTENCE_CONFIG_FILE}`);
  }
  const sentenceConfigPath = sentenceConfigPaths.find((candidate) => filesByPath.has(candidate));
  if (sentenceConfigPath) {
    const sentenceConfig = await fetchJsonFile(context, repository, revision, sentenceConfigPath);
    maxLength = positiveInteger(sentenceConfig.value.max_seq_length);
  }

  return { pooling, normalize: pipeline.length === 3, maxLength };
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

async function discoverFileIntegrity(context, repository, revision, file, knownFile) {
  const metadataChecksum = fileChecksum(file);
  const metadataSize = positiveInteger(file?.size) ?? positiveInteger(file?.lfs?.size);
  if (metadataChecksum && metadataSize) {
    return { size: metadataSize, sha256: metadataChecksum };
  }

  const downloaded = knownFile ?? (await fetchFile(context, repository, revision, file.path));
  return {
    size: downloaded.bytes.byteLength,
    sha256: createHash('sha256').update(downloaded.bytes).digest('hex')
  };
}

function fileChecksum(file) {
  const candidate = file?.lfs?.sha256 ?? file?.lfs?.oid;
  if (typeof candidate !== 'string') return undefined;
  const checksum = candidate.replace(/^sha256:/, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(checksum) ? checksum : undefined;
}

async function repositoryFiles(context, repository, revision) {
  const key = `${repository}@${revision}`;
  let files = context.fileLists.get(key);
  if (!files) {
    files = context.hubClient
      .getFiles(repository, revision)
      .then((value) => fileMap(value, repository));
    context.fileLists.set(key, files);
  }
  return files;
}

async function fetchJsonFile(context, repository, revision, remotePath) {
  const key = `${repository}@${revision}/${remotePath}`;
  let file = context.jsonFiles.get(key);
  if (!file) {
    file = fetchFile(context, repository, revision, remotePath).then(({ bytes }) => {
      try {
        return { bytes, value: JSON.parse(bytes.toString('utf8')) };
      } catch (error) {
        throw new Error(
          `Invalid JSON returned for '${repository}/${remotePath}' at ${revision}: ${error.message}`,
          { cause: error }
        );
      }
    });
    context.jsonFiles.set(key, file);
  }
  return file;
}

async function fetchFile(context, repository, revision, remotePath) {
  try {
    const bytes = await context.hubClient.getFile(repository, revision, remotePath);
    return { bytes: Buffer.from(bytes) };
  } catch (error) {
    throw new Error(
      `Cannot fetch Hugging Face file '${repository}/${remotePath}' at ${revision}: ${error.message}`,
      { cause: error }
    );
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function uniquePositiveInteger(values, repository, configPath) {
  const candidates = [
    ...new Set(values.map(positiveInteger).filter((value) => value !== undefined))
  ];
  if (candidates.length > 1) {
    throw new Error(
      `Conflicting embedding dimensions in '${repository}/${configPath}': ${candidates.join(', ')}`
    );
  }
  return candidates[0];
}

function minimumPositiveInteger(values) {
  const candidates = values.map(positiveInteger).filter((value) => value !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

const discoverModelDescriptor = discoverModel;

export { checkModel, discoverModel, discoverModelDescriptor };
