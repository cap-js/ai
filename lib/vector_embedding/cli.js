import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { installModel } from './model-install.js';
import { validateEmbeddingModel } from './embedding.js';
import {
  checkModel,
  MODEL_INSPECTION_INCOMPLETE,
  MODEL_TASK_UNSUPPORTED
} from './model-discovery.js';
import { createCliProgressReporter } from './progress.js';
import { createCliStyle, displayText, formatElapsed } from './cli-style.js';
import { getModelDirectory, getModelRoot } from './model-utils.js';

const HELP = `Usage:
  npx @cap-js/ai check-model <model>
  npx @cap-js/ai install-model <model> [--directory <path>]

Options:
  --directory <path>  Override the default ~/.cds/models cache root
                      Relative paths resolve from the CAP project root
  --help               Show this help
`;

async function runModelCommand(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? findProjectRoot(cwd);
  const { stdout = process.stdout } = options;
  const command = parseArguments(argv);
  if (command.help) {
    stdout.write(HELP);
    return;
  }

  if (command.name === 'check-model') {
    const check = options.check ?? checkModel;
    const started = performance.now();
    const result = await check(command.model, {
      fetchImpl: options.fetchImpl,
      hubClient: options.hubClient,
      hubUrl: options.hubUrl
    });
    stdout.write(
      formatModelCheck(result, { stdout, env: options.env, elapsedMs: performance.now() - started })
    );
    return result;
  }

  const install = options.install ?? installModel;
  const style = createCliStyle(stdout, options.env);
  const reporter =
    options.onProgress == null
      ? createCliProgressReporter({ stdout, env: options.env })
      : undefined;
  let validationElapsedMs;
  const onProgress = reporter
    ? (event) => {
        if (event.phase === 'validate:done') validationElapsedMs = event.elapsedMs;
        return reporter(event);
      }
    : options.onProgress;
  let result;
  try {
    if (reporter) {
      const modelDir = getModelDirectory(
        getModelRoot(command.directory, root, options.home),
        command.model
      );
      stdout.write(
        `using embedding model ${style.bold(displayText(command.model))}\n` +
          `${style.dim(`cache ${displayText(modelDir)}`)}\n\n`
      );
    }
    result = await install(command.model, {
      root,
      directory: command.directory,
      home: options.home,
      fetchImpl: options.fetchImpl,
      hubUrl: options.hubUrl,
      discover: options.discover,
      validate: options.validate ?? validateEmbeddingModel,
      timeoutMs: options.timeoutMs,
      retryMs: options.retryMs,
      onProgress,
      idleTimeoutMs: options.idleTimeoutMs,
      downloadTimeoutMs: options.downloadTimeoutMs
    });
  } finally {
    try {
      reporter?.close();
    } catch {
      // Terminal cleanup must not hide an installation failure.
    }
  }
  const { model, modelDir } = result;
  stdout.write(
    `${style.success('Installed')} ${style.bold(displayText(command.model))}` +
      `${model?.dimensions ? ` (${displayText(model.dimensions)} dimensions)` : ''}\n` +
      (validationElapsedMs !== undefined
        ? `${style.dim(`validated in ${formatElapsed(validationElapsedMs)} · ready to use`)}\n`
        : '') +
      `${style.dim(`cache ${displayText(modelDir)}`)}\n`
  );
}

function findProjectRoot(start = process.cwd()) {
  let directory = path.resolve(start);
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      if (pkg.cds !== undefined || dependencies['@sap/cds']) return directory;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(start);
    directory = parent;
  }
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const name = argv[0];
  if (name !== 'check-model' && name !== 'install-model') {
    throw new Error(`Unsupported command.\n\n${HELP}`);
  }

  let model;
  let directory;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--directory') {
      if (name !== 'install-model') {
        throw new Error("Unknown option '--directory' for check-model");
      }
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      directory = value;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown option '${argument}'`);
    if (model) throw new Error(`Unexpected argument '${argument}'`);
    model = argument;
  }

  if (!model) throw new Error('Specify a model name');
  return { name, directory, model };
}

function formatModelCheck(model, options = {}) {
  const style = createCliStyle(options.stdout, options.env);
  const modelFile = model.files.find(({ role }) => role === 'model');
  const groups = [
    [
      'Model',
      [
        ['Task', model.task ?? 'not declared'],
        ['Revision', model.revision],
        ['ONNX model', modelFile.path]
      ]
    ],
    [
      'Embedding',
      [
        ['Dimensions', model.dimensions],
        ['Input limit', `${model.maxLength} tokens`],
        ['Expected output', model.output.name],
        ['Pooling', model.output.pooling],
        ['Normalization', model.output.normalize ? 'enabled' : 'disabled'],
        ['Prompt pooling', model.output.includePrompt ? 'included' : 'excluded']
      ]
    ],
    [
      'Prompts',
      ['query', 'document'].map((name) => [
        name === 'query' ? 'Query' : 'Document',
        model.prompts?.[name] === undefined ? 'none' : JSON.stringify(model.prompts[name])
      ])
    ]
  ];
  const width = Math.max(...groups.flatMap(([, rows]) => rows.map(([label]) => label.length)));
  const body = groups
    .map(
      ([name, rows]) =>
        `${style.dim(name)}\n` +
        rows.map(([label, value]) => `  ${label.padEnd(width)}  ${displayText(value)}`).join('\n')
    )
    .join('\n\n');
  return (
    `${style.success('Likely compatible')}: ${style.bold(displayText(model.repository))}\n` +
    (options.elapsedMs !== undefined
      ? `${style.dim(`metadata inspected in ${formatElapsed(options.elapsedMs)}`)}\n`
      : '') +
    `\n${body}\n\n` +
    'Metadata only; no model weights downloaded.\n' +
    'ONNX Runtime not validated.\n\n' +
    `${style.dim('Next: install and validate with ONNX Runtime')}\n` +
    `npx @cap-js/ai install-model ${displayText(model.repository)}\n`
  );
}

function formatModelCommandError(error, options = {}) {
  const style = createCliStyle(options.stderr ?? process.stderr, options.env);
  const reason = displayText(error.message);
  if (error.code === MODEL_TASK_UNSUPPORTED) {
    return (
      `${style.error('[ERROR] Unsupported embedding task')}\n\n` +
      `  ${reason}\n` +
      '  Supported: sentence-similarity, feature-extraction\n\n' +
      'Choose a model intended for embeddings.\n' +
      `${style.dim('Installing will not bypass this check.')}\n`
    );
  }
  if (error.code === MODEL_INSPECTION_INCOMPLETE) {
    return (
      `${style.warning('[ERROR] Inspection incomplete')}\n\n` +
      `  ${reason}\n\n` +
      'Compatibility is unknown; ONNX Runtime not validated.\n' +
      'Check the repository metadata or choose another embedding model.\n'
    );
  }
  const lines = String(error.message).split('\n').map(displayText).join('\n');
  return `${style.error('[ERROR]')} ${lines}\n`;
}

export {
  HELP,
  findProjectRoot,
  formatModelCheck,
  formatModelCommandError,
  parseArguments,
  runModelCommand
};
