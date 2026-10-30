import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import cds from '@sap/cds';

const files = readdirSync('tests')
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => `tests/${file}`);

// Select tests here because pull_request_target uses the base branch's workflow.
if (Number(cds.version.split('.')[0]) >= 10) {
  files.push('tests/sqlite/embeddings/embeddings.test.js');
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
