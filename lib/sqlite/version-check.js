const REQUIREMENTS = {
  cds: { packageName: '@sap/cds', range: '^10.1', major: 10, minor: 1 },
  sqlite: { packageName: '@cap-js/sqlite', range: '^3.1', major: 3, minor: 1 }
};

function satisfiesCaret(version, { major, minor }) {
  if (typeof version !== 'string') return false;

  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;

  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2]);
  return actualMajor === major && actualMinor >= minor;
}

function readPackageVersion(packageName, requireModule) {
  try {
    return requireModule(`${packageName}/package.json`)?.version;
  } catch {
    return undefined;
  }
}

function validateAISQLiteServiceVersions({ cdsVersion, sqliteVersion, warn = () => {} }) {
  const cdsSupported = satisfiesCaret(cdsVersion, REQUIREMENTS.cds);
  const sqliteSupported = satisfiesCaret(sqliteVersion, REQUIREMENTS.sqlite);
  if (cdsSupported && sqliteSupported) return true;

  const foundCds = cdsVersion ?? 'unknown';
  const foundSQLite = sqliteVersion ?? 'unknown';
  warn(
    `AISQLiteService requires ${REQUIREMENTS.cds.packageName} ${REQUIREMENTS.cds.range} and ` +
      `${REQUIREMENTS.sqlite.packageName} ${REQUIREMENTS.sqlite.range}; found ` +
      `${REQUIREMENTS.cds.packageName} ${foundCds} and ` +
      `${REQUIREMENTS.sqlite.packageName} ${foundSQLite}. ` +
      'Local SQLite AI features may not work correctly.'
  );
  return false;
}

export { readPackageVersion, validateAISQLiteServiceVersions };
