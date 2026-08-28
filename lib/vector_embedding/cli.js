import fs from 'node:fs';
import path from 'node:path';

import { installModel } from './model-install.js';
import { validateEmbeddingModel } from './embedding.js';

const HELP = `Usage:
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

  const { modelDir } = await installModel(command.model, {
    root,
    directory: command.directory,
    home: options.home,
    fetchImpl: options.fetchImpl,
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
  if (argv[0] !== 'install-model') {
    throw new Error(`Unsupported command.\n\n${HELP}`);
  }

  let model;
  let directory;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--directory') {
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
  return { directory, model };
}

export { HELP, findProjectRoot, parseArguments, runModelCommand };
