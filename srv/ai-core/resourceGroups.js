import cds from '@sap/cds';
import { getProperty, parseResponse } from '../../lib/handlers/utils.js';

export async function createResourceGroup(req) {
  const token = await this._getToken();
  const aiCore = cds.env.requires.AICore;
  if (!req.data.resourceGroupId) {
    req.data.resourceGroupId = cds.utils.uuid();
  }
  // REVISIT: map req.data.tenantId to the CDS_TENANT_ID?!
  if (!req.data.labels || !req.data.labels.some((l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID')) {
    req.data.labels ??= [];
    req.data.labels.push({
      key: 'ext.ai.sap.com/CDS_TENANT_ID',
      value: cds.context.tenant
    });
  }
  const response = await fetch(
    `${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        resourceGroupId: req.data.resourceGroupId,
        labels: req.data.labels
      })
    }
  );
  return parseResponse(req, response);
}

export async function readResourceGroups(req) {
  const token = await this._getToken();
  const aiCore = cds.env.requires.AICore;
  const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where;
  let resourceGroupId = getProperty(where, 'resourceGroupId');
  let response;
  if (resourceGroupId) {
    response = await fetch(
      `${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups/${resourceGroupId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } else {
    const queryOptions = [];
    if (req.query.SELECT.limit?.rows?.val) {
      queryOptions.push(`$top=${req.query.SELECT.limit.rows.val}`);
    }
    if (req.query.SELECT.limit?.offset?.val) {
      queryOptions.push(`$skip=${req.query.SELECT.limit.offset.val}`);
    }
    let tenantId = getProperty(where, 'tenantId');
    if (tenantId) {
      queryOptions.push(`labelSelector=ext.ai.sap.com/CDS_TENANT_ID=${tenantId}`);
    }
    // TODO: support labelSelector for where clause (e.g. exists on labels)
    let url = `${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups`;
    if (queryOptions.length) {
      url += `?${queryOptions.join('&')}`;
    }
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  }
  return parseResponse(req, response);
}

export async function upsertResourceGroup(req) {
  const { resourceGroups } = this.entities;
  let resourceGroupId = getProperty(req.query.UPSERT.entries, 'resourceGroupId');
  if (resourceGroupId) {
    const resourceGroup = await this.run(SELECT.from(resourceGroups, resourceGroupId));
    if (resourceGroup) {
      return await this.run(UPDATE.entity(resourceGroups, resourceGroupId).with(req.data));
    } else {
      return await this.run(INSERT.into(resourceGroups).entries(req.data));
    }
  } else {
    return await this.run(INSERT.into(resourceGroups).entries(req.data));
  }
}

export async function updateResourceGroup(req) {
  const { resourceGroups } = this.entities;
  const token = await this._getToken();
  const aiCore = cds.env.requires.AICore;
  const where = req.query.UPDATE.entity.ref.at(-1)?.where || req.query.UPDATE.where;
  let resourceGroupId = getProperty(where, 'resourceGroupId');
  if (!resourceGroupId) {
    const tenantId = getProperty(where, 'tenantId');
    const resourceGroup = await this.run(SELECT.one.from(resourceGroups).where({ tenantId }));
    resourceGroupId = resourceGroup.resourceGroupId;
  }
  const response = await fetch(
    `${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups/${resourceGroupId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.data)
    }
  );
  return parseResponse(req, response);
}

export async function deleteResourceGroup(req) {
  const { resourceGroups } = this.entities;
  const token = await this._getToken();
  const aiCore = cds.env.requires.AICore;
  const where = req.query.DELETE.from.ref.at(-1)?.where || req.query.DELETE.where;
  let resourceGroupId = getProperty(where, 'resourceGroupId');
  if (!resourceGroupId) {
    const tenantId = getProperty(where, 'tenantId');
    const resourceGroup = await this.run(SELECT.one.from(resourceGroups).where({ tenantId }));
    resourceGroupId = resourceGroup.resourceGroupId;
  }
  const response = await fetch(
    `${aiCore.credentials.serviceurls.AI_API_URL}/v2/admin/resourceGroups/${resourceGroupId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return parseResponse(req, response);
}

export async function handleResourceGroupsForTenant(req) {
  const { resourceGroups } = this.entities;
  // Early return if multi tenancy is disabled
  if (!cds.env.requires.multitenancy && !cds.env.profiles.includes('mtx-sidecar'))
    return cds.env.requires['AICore']?.resourceGroup;

  const tenantId = req.data.tenant;
  if (this.tenantResourceGroups.get(tenantId)) {
    return this.tenantResourceGroups.get(tenantId);
  }
  const resources = await this.run(SELECT.from(resourceGroups).where({ tenantId }));
  if (resources.length) {
    this.tenantResourceGroups.set(tenantId, resources[0].resourceGroupId);
    return resources[0].resourceGroupId;
  } else {
    const { resourceGroupId } = await this.run(INSERT.into(resourceGroups).entries({ tenantId }));
    return resourceGroupId;
  }
}
