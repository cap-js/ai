import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadSQLiteService(requireModule = require) {
  try {
    const module = requireModule('@cap-js/sqlite');
    return module.default ?? module;
  } catch (error) {
    if (
      (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') &&
      /['"]@cap-js\/sqlite['"]/.test(error.message)
    ) {
      throw new Error(
        "Using ai-sqlite requires @cap-js/sqlite. Install it with 'npm add -D @cap-js/sqlite'.",
        { cause: error }
      );
    }
    throw error;
  }
}

export { loadSQLiteService };
