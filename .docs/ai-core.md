# SAP AI Core integration

The plugin exposes SAP AI Core resource groups, deployments, and configurations through the `AICore` CAP service. It also manages the resource groups and SAP-RPT-1 deployments used by recommendations.

> [!IMPORTANT]
> In multitenant applications with an MTX sidecar, include `@cap-js/ai` in the sidecar so tenant lifecycle events can manage SAP AI Core resources.

## Service binding

Production use requires an [SAP AI Core](https://help.sap.com/docs/sap-ai-core) service binding. A Cloud Foundry deployment can declare it like this:

```yaml
modules:
  - name: incidents-srv
    type: nodejs
    path: gen/srv
    requires:
      - name: incidents-ai-core

resources:
  - name: incidents-ai-core
    type: org.cloudfoundry.managed-service
```

A resource group is SAP AI Core's isolation boundary: it scopes deployments, configurations, and executions so that tenants cannot access each other's resources.
The plugin provisions one resource group per tenant in multitenant applications, and uses a single resource group otherwise.

Single-tenant applications use the `default` resource group unless configured otherwise:

```json
{
  "cds": {
    "requires": {
      "AICore": {
        "resourceGroup": "CUSTOM_RESOURCE_GROUP"
      }
    }
  }
}
```

## Query API

```js
const aiCore = await cds.connect.to('AICore');
const { resourceGroups, deployments, configurations } = aiCore.entities;

await aiCore.run(SELECT.from(resourceGroups));
await aiCore.run(SELECT.from(resourceGroups).where({ tenantId: cds.context.tenant }));
await aiCore.run(
  SELECT.from(deployments).where({
    'resourceGroup.resourceGroupId': resourceGroups[0].resourceGroupId
  })
);
```

Supported `cds.ql` operations:

| Operation              | `resourceGroups` | `deployments` | `configurations` |
| ---------------------- | ---------------- | ------------- | ---------------- |
| `READ` list and single | yes              | yes           | yes              |
| `CREATE`               | yes              | yes           | yes              |
| `UPDATE`               | yes              | yes           | no               |
| `UPSERT`               | yes              | yes           | no               |
| `DELETE`               | yes              | yes           | no               |
| `limit`                | yes              | yes           | yes              |
| `search`               | no               | no            | yes              |

Filters are limited to simple equality checks:

- `resourceGroups`: `tenantId`, `resourceGroupId`
- `deployments`: `id`, `resourceGroup.resourceGroupId`
- `configurations`: `resourceGroup.resourceGroupId`

## Helper methods

```js
const aiCore = await cds.connect.to('AICore');
const { resourceGroups, deployments } = aiCore.entities;

const resourceGroupId = await aiCore.resourceGroupForTenant(cds.context.tenant);
const predictions = await aiCore.predictRowColumns(/* SAP-RPT-1 payload */);
const deploymentId = await aiCore.rpt1DeploymentId(resourceGroups, { resourceGroupId });
await aiCore.stop(deployments, { id: deploymentId });
```

`rpt1DeploymentId` creates an SAP-RPT-1 deployment when the resource group does not already have one.
