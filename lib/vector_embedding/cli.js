import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getModelCacheDir,
  getModelCacheRoot,
  provisionModel,
  validateModelDescriptor
} from './model-utils.js';
import { resolveModelPreset } from './models.js';

const HELP = `Usage:
  cds-ai model install <model> [--directory <path>]
  cds-ai model install --descriptor <path> [--directory <path>]

Options:
  --directory <path>   Install into an application-managed directory
  --descriptor <path>  Read a compatible custom model descriptor from JSON
  --help               Show this help
`;

async function runModelCommand(argv, options = {}) {
  const { cwd = process.cwd(), env = process.env, fetchImpl, stdout = process.stdout } = options;
  const command = parseArguments(argv);
  if (command.help) {
    stdout.write(HELP);
    return;
  }

  const model = command.descriptor
    ? await readDescriptor(path.resolve(cwd, command.descriptor))
    : resolveModelPreset(command.model);
  const directory = command.directory
    ? path.resolve(cwd, command.directory)
    : getModelCacheDir(getModelCacheRoot(env), model);

  await provisionModel(model, { directory, env, fetchImpl });
  stdout.write(`Provisioned ${model.repository} in ${directory}\n`);
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv[0] !== 'model' || argv[1] !== 'install') {
    throw new Error(`Unsupported command.\n\n${HELP}`);
  }

  let model;
  let descriptor;
  let directory;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--descriptor' || argument === '--directory') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--descriptor') descriptor = value;
      else directory = value;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown option '${argument}'`);
    if (model) throw new Error(`Unexpected argument '${argument}'`);
    model = argument;
  }

  if (descriptor && model) throw new Error('Specify either a model name or --descriptor, not both');
  if (!descriptor && !model) throw new Error('Specify a model name or --descriptor');
  return { descriptor, directory, model };
}

async function readDescriptor(file) {
  let descriptor;
  try {
    descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read embedding model descriptor at ${file}: ${error.message}`, {
      cause: error
    });
  }
  return validateModelDescriptor(descriptor);
}

export { HELP, parseArguments, runModelCommand };
