import fs from 'node:fs/promises';
import path from 'node:path';
import { provisionModel, validateModelDescriptor } from './model-utils.js';

const HELP = `Usage:
  cds-ai model install --descriptor <path> --directory <path>

Options:
  --directory <path>   Install into an application-managed directory
  --descriptor <path>  Read a compatible model descriptor from JSON
  --help               Show this help
`;

async function runModelCommand(argv, options = {}) {
  const { cwd = process.cwd(), fetchImpl, stdout = process.stdout } = options;
  const command = parseArguments(argv);
  if (command.help) {
    stdout.write(HELP);
    return;
  }

  const model = await readDescriptor(path.resolve(cwd, command.descriptor));
  const directory = path.resolve(cwd, command.directory);

  await provisionModel(model, { directory, fetchImpl });
  stdout.write(`Provisioned ${model.repository} in ${directory}\n`);
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv[0] !== 'model' || argv[1] !== 'install') {
    throw new Error(`Unsupported command.\n\n${HELP}`);
  }

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
    throw new Error(`Unexpected argument '${argument}'`);
  }

  if (!descriptor) throw new Error('--descriptor is required');
  if (!directory) throw new Error('--directory is required');
  return { descriptor, directory };
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
