const cds = require('@sap/cds');

async function main() {
  const aiCore = await cds.connect.to('AICore');
  let deletedGroups = 0;
  const testId = process.env.CAP_AI_TEST_ID;
  if (testId) {
    const testTenantIds = new Set([`test-aicore-${testId}`, `mtx-test-${testId}`]);
    const groups = await aiCore.run(SELECT.from('AICore.resourceGroups'));
    for (const g of groups) {
      const belongsToThisRun = g.labels?.some(
        (label) => label.key === 'ext.ai.sap.com/CDS_TENANT_ID' && testTenantIds.has(label.value)
      );
      if (!belongsToThisRun) continue;
      try {
        await aiCore.run(
          DELETE.from('AICore.resourceGroups').where({ resourceGroupId: g.resourceGroupId })
        );
        deletedGroups++;
      } catch {
        /* best-effort */
      }
    }
  } else {
    console.log('Skipped test resource group cleanup without CAP_AI_TEST_ID');
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
