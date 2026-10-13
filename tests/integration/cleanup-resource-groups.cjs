const cds = require('@sap/cds');

async function main() {
  const aiCore = await cds.connect.to('AICore');
  const groups = await aiCore.run(SELECT.from('AICore.resourceGroups'));
  let deletedGroups = 0;
  for (const g of groups) {
    const tenantLabel = g.labels?.find((l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID');
    if (!tenantLabel) continue;
    const isTestGroup = tenantLabel.value.startsWith('test-aicore-');
    if (!isTestGroup) continue;
    try {
      await aiCore.run(
        DELETE.from('AICore.resourceGroups').where({ resourceGroupId: g.resourceGroupId })
      );
      deletedGroups++;
    } catch {
      /* best-effort */
    }
  }
  console.log('Cleaned up ' + deletedGroups + ' test resource groups');

  const STALE_STATUS = new Set(['UNKNOWN', 'DEAD', 'STOPPED']);
  let deletedDeployments = 0;
  try {
    const deployments = await aiCore.run(
      SELECT.from('AICore.deployments').where({ 'resourceGroup.resourceGroupId': 'default' })
    );
    for (const d of deployments ?? []) {
      if (!STALE_STATUS.has(d.status)) continue;
      try {
        await aiCore.run(
          DELETE.from('AICore.deployments').where({
            id: d.id,
            'resourceGroup.resourceGroupId': 'default'
          })
        );
        deletedDeployments++;
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* listing may fail if AI Core is unavailable — do not fail the cleanup */
  }
  console.log('Cleaned up ' + deletedDeployments + " stale deployments in 'default'");
}
main().catch(console.error);
