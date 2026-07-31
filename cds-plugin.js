import cds from '@sap/cds';

import enhanceModelWithRecommendations from './lib/csn-enhancements/recommendations.js';
import registerHandlersForRecommendations from './lib/handlers/recommendations.js';
import registerMtxHandlers from './lib/mtx/index.js';
import addSQLiteVectorSupport from './lib/vector_handling/index.js';

const LOG = cds.log('@cap-js/ai');

// Extend SQLiteService class to add vector support
const originalSQLiteService = await (async () => {
  try {
    const mod = await import('@cap-js/sqlite');
    return mod.default || mod;
  } catch (e) {
    LOG.warn('Failed to import @cap-js/sqlite:', e.message);
    return null;
  }
})();

if (originalSQLiteService) {
  // Patch the factory getter on the prototype to add VECTOR_EMBEDDING function
  const originalFactoryDescriptor = Object.getOwnPropertyDescriptor(
    originalSQLiteService.prototype,
    'factory'
  );

  if (originalFactoryDescriptor && originalFactoryDescriptor.get) {
    Object.defineProperty(originalSQLiteService.prototype, 'factory', {
      get() {
        const originalFactory = originalFactoryDescriptor.get.call(this);
        const originalCreate = originalFactory.create;

        return {
          ...originalFactory,
          create: async (tenant) => {
            const dbc = await originalCreate.call(originalFactory, tenant);

            // Register VECTOR_EMBEDDING function on this connection
            try {
              await addSQLiteVectorSupport(dbc);
            } catch (err) {
              LOG.warn('Failed to register VECTOR_EMBEDDING:', err.message);
            }

            return dbc;
          }
        };
      },
      configurable: true
    });
  }
}

cds.on('compile.for.runtime', enhanceModelWithRecommendations);
cds.on('compile.to.edmx', enhanceModelWithRecommendations);

cds.on('served', async (services) => {
  // Register other handlers
  for (const name in services) {
    if (name === 'db') continue;
    // eslint-disable-next-line no-await-in-loop
    const srv = await cds.connect.to(name);
    registerHandlersForRecommendations(srv);

    if (name === 'cds.xt.DeploymentService') {
      registerMtxHandlers(srv);
    }
  }
});
