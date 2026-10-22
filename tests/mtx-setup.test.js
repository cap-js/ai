import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { ensureSidecarPlugin, ROOT_DIR, SIDECAR_DIR } from './integration/mtx-setup.js';

const require = createRequire(path.join(ROOT_DIR, 'package.json'));
const packagePath = path.join(SIDECAR_DIR, 'package.json');
const originalPackage = '{"dependencies":{"@cap-js/ai":"file:../../../../"}}';

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function setup(versions, installError) {
  const packageVersions = new Map(
    Object.entries(versions).map(([name, version]) => [
      require.resolve(`${name}/package.json`),
      JSON.stringify({ version })
    ])
  );
  const read = fs.readFileSync;
  let manifest = originalPackage;
  mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === packagePath) return manifest;
    return packageVersions.get(file) ?? read(file, ...args);
  });
  mock.method(fs, 'writeFileSync', (file, content) => {
    assert.equal(file, packagePath);
    manifest = content;
  });
  mock.method(os, 'tmpdir', () => path.join(ROOT_DIR, 'temporary path with spaces'));
  const calls = [];
  mock.method(childProcess, 'execSync', () => assert.fail('npm arguments must not use a shell'));
  mock.method(childProcess, 'execFileSync', (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'pack') return 'cap-js-ai-1.2.1.tgz\n';
    assert.equal(args[0], 'install');
    manifest = '{"dependencies":{"@cap-js/ai":"changed by npm"}}';
    if (installError) throw installError;
    return '';
  });
  syncBuiltinESMExports();
  return { calls, manifest: () => manifest };
}

for (const versions of [
  { '@sap/cds': '9.9.4', '@cap-js/sqlite': '2.4.3', '@sap/cds-mtxs': '3.9.8' },
  { '@sap/cds': '10.1.1', '@cap-js/sqlite': '3.1.2', '@sap/cds-mtxs': '4.1.1' }
]) {
  test(`sidecar installation matches the selected CDS ${versions['@sap/cds']} stack`, () => {
    const { calls, manifest } = setup(versions);
    ensureSidecarPlugin();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      command: 'npm',
      args: ['pack', '--pack-destination', os.tmpdir()],
      options: { cwd: ROOT_DIR, encoding: 'utf-8' }
    });
    assert.deepEqual(calls[1], {
      command: 'npm',
      args: [
        'install',
        path.join(os.tmpdir(), 'cap-js-ai-1.2.1.tgz'),
        ...Object.entries(versions).map(([name, version]) => `${name}@${version}`)
      ],
      options: { cwd: SIDECAR_DIR, encoding: 'utf-8', stdio: 'inherit' }
    });
    assert.equal(manifest(), originalPackage);
  });
}

test('sidecar package manifest is restored when npm installation fails', () => {
  const error = new Error('npm installation failed');
  const { calls, manifest } = setup(
    { '@sap/cds': '9.9.4', '@cap-js/sqlite': '2.4.3', '@sap/cds-mtxs': '3.9.8' },
    error
  );
  assert.throws(
    () => ensureSidecarPlugin(),
    (actual) => actual === error
  );
  assert.equal(calls[1].options.stdio, 'inherit');
  assert.equal(manifest(), originalPackage);
});
