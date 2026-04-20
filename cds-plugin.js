import cds from '@sap/cds';
const LOG = cds.log('@cap-js/ai');

import { default as enhanceModelWithRecommendations } from './lib/csn-enhancements/recommendations.js';

import registerHandlersForRecommendations from './lib/handlers/recommendations.js';

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

		// Register MTX handlers
		if (name === 'cds.xt.DeploymentService') {
			srv.after('subscribe', async (_, req) => {
				const { tenant } = req.data;
				try {
					const aiCore = await cds.connect.to('AICore');
					const id = await aiCore.resourceGroupForTenant({ tenant });
					LOG.debug(
						`Upsert for the AI Core resource group ${id} on subscribe for tenant ${tenant}`
					);
				} catch (error) {
					LOG.error(`Error setting up AI Core resource group for tenant - ${tenant}`, error);
				}
			});

			srv.after('unsubscribe', async (_, req) => {
				const { tenant } = req.data;
				try {
					const aiCore = await cds.connect.to('AICore');
					await aiCore.run(DELETE.from('AICore.resourceGroups').where({ tenantId: tenant }));
					LOG.debug(`Deleted the AI Core resource group on unsubscribe for tenant ${tenant}`);
				} catch (error) {
					LOG.error(`Error deleting AI Core resource group for tenant - ${tenant}`, error);
				}
			});
		}
	}
});
