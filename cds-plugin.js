import cds from '@sap/cds';

import enhanceModelWithRecommendations from './lib/csn-enhancements/recommendations.js';
import registerHandlersForRecommendations from './lib/handlers/recommendations.js';
import registerMtxHandlers from './lib/mtx/index.js';
import addSQLiteVectorSupport from './lib/vector_handling/index.js';

cds.on('compile.for.runtime', enhanceModelWithRecommendations);
cds.on('compile.to.edmx', enhanceModelWithRecommendations);

cds.on('served', async (services) => {
  for (const name in services) {
    if (name === 'db') {
      // Register vector support for SQLite
      const db = await cds.connect.to('db');
      if (db.kind === 'sqlite') {
        // Access the underlying database connection
        const dbc = db.dbc;
        if (dbc) {
          await addSQLiteVectorSupport(dbc);
        }
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const srv = await cds.connect.to(name);
    registerHandlersForRecommendations(srv);

    if (name === 'cds.xt.DeploymentService') {
      registerMtxHandlers(srv);
    }
  }
});
