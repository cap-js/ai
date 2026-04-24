const cds = require('@sap/cds');

async function main() {
  const aiCore = await cds.connect.to('AICore');
  const groups = await aiCore.run(SELECT.from('AICore.resourceGroups'));
  let deleted = 0;
  for (const g of groups) {
    const tenantLabel = g.labels?.find((l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID');
    if (!tenantLabel) continue;
    const isTestGroup =
      tenantLabel.value.startsWith('test-aicore-');
    if (!isTestGroup) continue;
    try {
      await aiCore.run(
        DELETE.from('AICore.resourceGroups').where({ resourceGroupId: g.resourceGroupId })
      );
      deleted++;
    } catch {
      /* best-effort */
    }
  }
  console.log('Cleaned up ' + deleted + ' test resource groups');
}
main().catch(console.error);
