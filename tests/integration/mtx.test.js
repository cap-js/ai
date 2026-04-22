import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import cdsTest from '@cap-js/cds-test';
import {
  BOOKSHOP_DIR,
  ensureSidecarPlugin,
  cleanDbFiles,
  startSidecar,
  subscribeTenant,
  unsubscribeTenant,
  stopSidecar
} from './mtx-setup.js';

let sidecar;
const testTenantId = `mtx-test-${Date.now()}`;

before(async () => {
  ensureSidecarPlugin();
  cleanDbFiles();
  sidecar = await startSidecar();
});

after(async () => {
  // Best-effort cleanup: delete resource group if still present
  try {
    const aiCore = await cds.connect.to('AICore');
    cds.context = new cds.EventContext({ tenant: testTenantId });
    await aiCore.run(DELETE.from('AICore.resourceGroups').where({ tenantId: testTenantId }));
  } catch {
    /* already deleted or never created */
  }
  await stopSidecar(sidecar?.proc);
});

// Bootstrap main app — serves business services for tenant requests
cdsTest(BOOKSHOP_DIR);

describe('AICore MTX resource group lifecycle', { concurrency: false, timeout: 120_000 }, () => {
  let aiCore;

  before(async () => {
    aiCore = await cds.connect.to('AICore');
  });

  test('subscribe creates a resource group for the tenant', async () => {
    const status = await subscribeTenant(testTenantId, sidecar.port);
    assert.ok(
      status === 200 || status === 201 || status === 204,
      `Subscribe should succeed, got ${status}`
    );

    // after('subscribe') handler creates resource group asynchronously — poll until it appears
    let groups = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500 * i)); // eslint-disable-line no-await-in-loop
      cds.context = new cds.EventContext({ tenant: testTenantId });
      // eslint-disable-next-line no-await-in-loop
      groups = await aiCore.run(
        SELECT.from('AICore.resourceGroups').where({ tenantId: testTenantId })
      );
      if (Array.isArray(groups) && groups.length > 0) break;
    }
    assert.ok(Array.isArray(groups), 'Should return array');
    assert.ok(
      groups.length >= 1,
      `Resource group should exist for ${testTenantId} after subscribe`
    );
    const tenantLabel = groups[0].labels?.find((l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID');
    assert.ok(tenantLabel, 'Resource group should have CDS_TENANT_ID label');
    assert.strictEqual(tenantLabel.value, testTenantId);
  });

  test('unsubscribe deletes the resource group for the tenant', async () => {
    // Wait for resource group to finish provisioning before unsubscribe
    let provisioned = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000)); // eslint-disable-line no-await-in-loop
      cds.context = new cds.EventContext({ tenant: testTenantId });
      // eslint-disable-next-line no-await-in-loop
      const groups = await aiCore.run(
        SELECT.from('AICore.resourceGroups').where({ tenantId: testTenantId })
      );
      if (Array.isArray(groups) && groups[0]?.status === 'PROVISIONED') {
        provisioned = true;
        break;
      }
    }
    assert.ok(provisioned, 'Resource group should reach PROVISIONED before unsubscribe');

    const status = await unsubscribeTenant(testTenantId, sidecar.port);
    assert.ok(status === 200 || status === 204, `Unsubscribe should succeed, got ${status}`);

    // Wait for deletion to propagate
    await new Promise((r) => setTimeout(r, 80000));
    cds.context = new cds.EventContext({ tenant: testTenantId });
    const groups = await aiCore.run(
      SELECT.from('AICore.resourceGroups').where({ tenantId: testTenantId })
    );
    const stillExists = Array.isArray(groups) && groups.length > 0;
    assert.strictEqual(
      stillExists,
      false,
      `Resource group should be deleted after unsubscribe for ${testTenantId}`
    );
  });
});
