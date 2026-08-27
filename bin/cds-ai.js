#!/usr/bin/env node

import { runModelCommand } from '../lib/vector_embedding/cli.js';

try {
  await runModelCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
