import cds from '@sap/cds';

import enhanceModelWithRecommendations from './lib/csn-enhancements/recommendations.js';
import registerHandlersForRecommendations from './lib/handlers/recommendations.js';
import registerMtxHandlers from './lib/mtx/index.js';
import { buildN8nRouter, mountN8nStatic } from './lib/n8n/api-adapter.js';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url)
const N8nAdapter = _require('./lib/n8n/N8nAdapter.cjs')

// Register 'n8n' as a CAP protocol adapter.
// path:'' means the endpoint path comes entirely from the @n8n annotation on the service.
// This must happen before cds.Service.protocols is first accessed (i.e. before serve).
cds.service.protocols['n8n'] = { impl: N8nAdapter, path: '' }

// Inject the ESM buildN8nRouter into the CJS adapter class.
N8nAdapter.inject(buildN8nRouter)

cds.on('compile.for.runtime', enhanceModelWithRecommendations);
cds.on('compile.to.edmx', enhanceModelWithRecommendations);

cds.on('served', async (services) => {
  // Mount n8n static files + SPA fallback AFTER the API router is registered
  // by the protocol adapter. Order matters: API routes must catch /rest/* before
  // the SPA fallback returns index.html for every unmatched path.
  const n8nCfg = cds.env.requires?.n8n
  if (n8nCfg && cds.app) {
    mountN8nStatic(cds.app, n8nCfg)
  }

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

