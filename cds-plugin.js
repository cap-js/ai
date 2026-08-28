import cds from '@sap/cds';

import enhanceModelWithRecommendations from './lib/csn-enhancements/recommendations.js';
import registerHandlersForRecommendations from './lib/handlers/recommendations.js';
import registerMtxHandlers from './lib/mtx/index.js';

cds.on('compile.for.runtime', enhanceModelWithRecommendations);
cds.on('compile.to.edmx', enhanceModelWithRecommendations);

cds.on('served', async (services) => {
  for (const name in services) {
    if (name === 'db') continue;
    // eslint-disable-next-line no-await-in-loop
    const srv = await cds.connect.to(name);
    if (isExternal(srv)) continue; // external services carry no @UI.Recommendations
    registerHandlersForRecommendations(srv);

    if (name === 'cds.xt.DeploymentService') {
      registerMtxHandlers(srv);
    }
  }
});

const isExternal = (srv) => !!(srv.definition?.['@cds.external'] || srv.definition?.is_external);
