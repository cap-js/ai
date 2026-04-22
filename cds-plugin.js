import cds from '@sap/cds';

import { default as enhanceModelWithRecommendations } from './lib/csn-enhancements/recommendations.js';

import registerHandlersForRecommendations from './lib/handlers/recommendations.js';
import registerMtxHandlers from './lib/mtx/index.js';

cds.on('compile.for.runtime', (model) => {
	enhanceModelWithRecommendations(model);
});
cds.on('compile.to.edmx', (model) => {
	enhanceModelWithRecommendations(model);
});

cds.on('served', async (services) => {
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
