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
    // Skip external/mock services — they have no @UI.Recommendations model.
    // CAP sets `srv.mocked = true` on services declared as external
    // (`kind: rest`, `kind: odata`, …) when they fall back to an in-process
    // implementation file or run without real credentials. See
    // @sap/cds/lib/srv/cds-serve.js (`if (d.is_external) srv.mocked = true`).
    // Without this filter, the handler below crashes on `req.target.isDraft`
    // for free-form remote calls like `srv.send(new cds.Request({ path }))`.
    if (srv.mocked) continue;
    registerHandlersForRecommendations(srv);

    if (name === 'cds.xt.DeploymentService') {
      registerMtxHandlers(srv);
    }
  }
});
