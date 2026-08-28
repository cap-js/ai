import fs from 'node:fs';
import path from 'node:path';

import { installModel } from './model-install.js';
import { validateEmbeddingModel } from './embedding.js';
import { checkModel } from './model-discovery.js';

const HELP = `Usage:
  npx @cap-js/ai check-model <model>
  npx @cap-js/ai install-model <model> [--directory <path>]

Options:
  --directory <path>  Use this model-cache root (relative to the CAP project root)
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
    const result = await check(command.model, {
      fetchImpl: options.fetchImpl,
      hubClient: options.hubClient,
      hubUrl: options.hubUrl
    });
    stdout.write(formatModelCheck(result));
    return result;
  }

  const install = options.install ?? installModel;
  const { modelDir } = await install(command.model, {
    root,
    directory: command.directory,
    home: options.home,
    fetchImpl: options.fetchImpl,
    hubUrl: options.hubUrl,
    discover: options.discover,
    validate: options.validate ?? validateEmbeddingModel,
    timeoutMs: options.timeoutMs,
    retryMs: options.retryMs
  });
  stdout.write(`Installed ${command.model} in ${modelDir}\n`);
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

function formatModelCheck(model) {
  const modelFile = model.files.find(({ role }) => role === 'model');
  return `Likely compatible: ${model.repository}
Revision: ${model.revision}
Task: ${model.task ?? 'not declared'}
ONNX: ${modelFile.path}
Dimensions: ${model.dimensions}
Maximum input length: ${model.maxLength}
Expected ONNX output: ${model.output.name}
Pooling: ${model.output.pooling}
Normalization: ${model.output.normalize ? 'enabled' : 'disabled'}

Run 'npx @cap-js/ai install-model ${model.repository}' for definitive ONNX Runtime validation.
`;
}

export { HELP, findProjectRoot, formatModelCheck, parseArguments, runModelCommand };
