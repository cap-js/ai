import cds from '@sap/cds';
const LOG = cds.log('@cap-js/ai');

export default function registerMtxHandlers(srv) {
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
			await aiCore.run(DELETE.from(aiCore.entities.resourceGroups).where({ tenantId: tenant }));
			LOG.debug(`Deleted the AI Core resource group on unsubscribe for tenant ${tenant}`);
		} catch (error) {
			LOG.error(`Error deleting AI Core resource group for tenant - ${tenant}`, error);
		}
	});
}
