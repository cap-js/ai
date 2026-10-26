#!/usr/bin/env node

import { formatModelCommandError, runModelCommand } from '../lib/vector_embedding/cli.js';

try {
  await runModelCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(formatModelCommandError(error));
  process.exitCode = 1;
}
