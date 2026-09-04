import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  readPackageVersion,
  validateAISQLiteServiceVersions
} from '../lib/sqlite/version-check.js';

describe('AISQLiteService dependency versions', () => {
  test('accepts versions within the supported ranges', () => {
    const warnings = [];

    assert.equal(
      validateAISQLiteServiceVersions({
        cdsVersion: '10.1.0',
        sqliteVersion: '3.1.0',
        warn: (message) => warnings.push(message)
      }),
      true
    );
    assert.equal(
      validateAISQLiteServiceVersions({
        cdsVersion: '10.9.4',
        sqliteVersion: '3.8.2',
        warn: (message) => warnings.push(message)
      }),
      true
    );
    assert.deepEqual(warnings, []);
  });

  test('warns for versions outside the supported ranges', () => {
    const warnings = [];

    assert.equal(
      validateAISQLiteServiceVersions({
        cdsVersion: '10.0.6',
        sqliteVersion: '3.0.2',
        warn: (message) => warnings.push(message)
      }),
      false
    );
    assert.equal(
      validateAISQLiteServiceVersions({
        cdsVersion: '11.0.0',
        sqliteVersion: '4.0.0',
        warn: (message) => warnings.push(message)
      }),
      false
    );

    for (const warning of warnings) {
      assert.match(warning, /@sap\/cds \^10\.1/);
      assert.match(warning, /@cap-js\/sqlite \^3\.1/);
      assert.match(warning, /Local SQLite AI features may not work correctly/);
    }
    assert.match(warnings[0], /@sap\/cds 10\.0\.6/);
    assert.match(warnings[0], /@cap-js\/sqlite 3\.0\.2/);
    assert.match(warnings[1], /@sap\/cds 11\.0\.0/);
    assert.match(warnings[1], /@cap-js\/sqlite 4\.0\.0/);
  });

  test('warns when an installed version cannot be determined', () => {
    const warnings = [];

    assert.equal(
      validateAISQLiteServiceVersions({
        cdsVersion: undefined,
        sqliteVersion: 'not-semver',
        warn: (message) => warnings.push(message)
      }),
      false
    );
    assert.match(warnings[0], /@sap\/cds unknown/);
    assert.match(warnings[0], /@cap-js\/sqlite not-semver/);
  });

  test('reads package versions without exposing lookup failures', () => {
    assert.equal(
      readPackageVersion('@cap-js/sqlite', (specifier) => {
        assert.equal(specifier, '@cap-js/sqlite/package.json');
        return { version: '3.1.4' };
      }),
      '3.1.4'
    );
    assert.equal(
      readPackageVersion('@cap-js/sqlite', () => {
        throw new Error('package metadata is not exported');
      }),
      undefined
    );
  });
});
