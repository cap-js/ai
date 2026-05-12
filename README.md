[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/ai)](https://api.reuse.software/info/github.com/cap-js/ai)

# SAP Cloud Application Programming Model, AI plugin for Node.js

## About this project

The SAP Cloud Application Programming Model, AI plugin for Node.js bundles two AI capabilities to infuse into your CAP applications:
1. UI Recommendations
2. Simplified AI Core usage

> [!IMPORTANT]
> In multi tenancy scenarios with a sidecar the plugin must be included in the sidecar for SAP AI Core handling.

### 1. Use case: Recommendations

Recommendations are implemented leveraging SAP-RPT-1 and AI Core. This plugin generically hooks into any entity which has properties with a value help (detected via `@Common.ValueList` on the property or `@cds.odata.valuelist` on the association target).

```cds 
entity Books {
  key ID : Integer;
  title  : String(111);
  descr  : String(1111);
  genre : Association to one Genres;
  status : Association to one Status;
}
annotate Genres with @cds.odata.valuelist;
annotate Books with {
    status @Common.ValueList : {
        CollectionPath : 'Status',
        Parameters: [
            {
                $Type: 'Common.ValueListParameterInOut'
                ValueListProperty : 'code',
                LocalDataProperty : status_code
            }
        ]
    }
}
```

![Recommendations as default values](./_assets/recommendation-default.png)
![Recommendation in Value Help](./_assets/recommendation-value-help.png)
![Accept recommendations](./_assets/accept-recommendations.png)

The genre field on the UI now automatically has recommendations. If you do not want recommendations for a specific field, it can be annotated with `@UI.RecommendationState`.

```cds
annotate Books with {
    genre @UI.RecommendationState : 0;
}
```

Dynamic expressions as values for `@UI.RecommendationState`, work as well!

```cds
annotate Books with {
    genre @UI.RecommendationState : (price > 200 ? 0 : 1);
}
```

#### Recommendations on fields without a value help

By default the plugin only enhances fields that have a value list — that's how it auto-detects which columns are good prediction targets. Some fields are good targets but have no value list: free-form numerics like measurement ranges, calibration values, or planning estimates. Annotate these with `@UI.RecommendationState : 1` to opt in:

```cds
entity CalibrationData : cuid {
  measuringRangeMin : Decimal(16, 6) @UI.RecommendationState : 1;
  measuringRangeMax : Decimal(16, 6) @UI.RecommendationState : 1;
  operatingPoint    : Decimal(16, 6) @UI.RecommendationState : 1;
  description       : String         @UI.RecommendationState : 1;
}
```

The annotation only takes effect on **scalar** elements (no associations / compositions / unmanaged elements; for those, attach a value help instead). Annotated fields are added to the entity's `<Entity>_Recommendations` companion just like value-helped fields, and Fiori Elements' soft-fill placeholder renders the prediction in the empty input.

`task_type` is chosen automatically per column:
- numeric scalar (`Integer*`, `Decimal`, `Double`) annotated with `@UI.RecommendationState` → **`regression`** so RPT-1 can interpolate continuous values,
- everything else → **`classification`**.

> [!NOTE]
> Numeric fields that have a value help (e.g. a fixed price-point list) stay on classification — `@UI.RecommendationState` is only needed when there is *no* value help. Combining both is unnecessary.

#### How recommendations work under the hood

A short FAQ for integrators, so you don't have to read the source.

**What does the plugin emit on the OData service?**
On every draft-enabled entity that has at least one value-helped field, it adds an entity-level annotation `@UI.Recommendations: { '=': 'SAP_Recommendations' }` plus a synthetic companion entity (`<Entity>_Recommendations`, `@cds.persistence.skip`) with one virtual array per recommendable field. Each item carries `RecommendedFieldValue`, `RecommendedFieldDescription`, `RecommendedFieldScoreValue` and `RecommendedFieldIsSuggestion` — the shape Fiori Elements expects for `UI.RecommendationListType`. The first entry per field has `RecommendedFieldIsSuggestion: true` and is rendered as the soft-fill default.

**When does it run?**
On READ requests to a draft entity that expand `SAP_Recommendations`. Reads against the active entity return nothing in that field. Reads during `draftActivate` are skipped.

**What data is sent to RPT-1 as context?**
Up to 2000 rows from the **active** version of the same entity, restricted to rows where every recommendable field is non-null. The columns `createdAt`, `createdBy`, `modifiedAt`, `modifiedBy` plus any `cds.LargeBinary` / `cds.Vector` elements are stripped. The active row corresponding to the draft (if any) is removed and replaced by the draft row carrying `[PREDICT]` placeholders in the columns to predict. There is no sampling or `ORDER BY` — for tables larger than 2000 rows, which rows make the cut is determined by the database.

> [!IMPORTANT]
> Everything in the remaining columns is forwarded to AI Core. Annotate sensitive fields with `@UI.RecommendationState : 0` (or a dynamic expression) to keep them out of both the predictions and the context payload.

**How are descriptions populated?**
For each predicted value, the plugin issues an extra SELECT against the field's `@Common.Text` association (if set) to fetch the human-readable label. Fields without `@Common.Text` get an empty `RecommendedFieldDescription`.

**RPT-1 deployment lifecycle**
First prediction call against a resource group provisions an `sap-rpt-1-small` deployment in scenario `foundation-models` (executable `aicore-sap`) and polls up to 10× with exponential backoff until it reaches `RUNNING`. Subsequent calls reuse the cached deployment. Single-tenant uses the configured `resourceGroup` (default `'default'`); multi-tenant creates one resource group per tenant on subscribe (label `ext.ai.sap.com/CDS_TENANT_ID`) and deletes it on unsubscribe.

**Local development**
Without an AI Core binding the plugin uses `MockAICoreService`, which returns the first non-null value of each target column from the context as the "prediction" — useful for UI smoke tests, useless as a quality signal. Run `cds bind <your-aicore-instance>` and start with profile `hybrid` to talk to a real AI Core deployment locally.

### 2. Use case: Simplified AI Core usage

The plugin introduces an `AICore` CAP service that automatically performs some administrative tasks and offers simplified access to AI Core.

#### Automatic operations

- The plugin automatically creates a new SAP AI Core resource group per tenant during tenant onboarding and deletes it during offboarding.
- The plugin automatically creates an RPT-1 deployment per resource group for the recommendations feature.

#### Simplified AI Core API access

```js
const aiCore = await cds.connect.to('AICore');
const {resourceGroups, deployments, configurations} = aiCore.entities;
await aiCore.run(SELECT.from(resourceGroups));
await aiCore.run(SELECT.from(resourceGroups).where({tenantId: cds.context.tenant}));
await aiCore.run(SELECT.from(deployments).where({'resourceGroup.resourceGroupId': resourceGroups[0].resourceGroupId}));
await aiCore.run(SELECT.from(configurations).where({'resourceGroup.resourceGroupId': resourceGroups[0].resourceGroupId}));
```

Currently, the following `cds.ql` operations are supported:

| Operation | resourceGroups | deployments | configurations |
|-----------|---------------|-------------|----------------|
| **READ (list)** | ✓ | ✓ | ✓ |
| - limit | ✓ | ✓ | ✓ |
| - where* | `tenantId`, `resourceGroupId` | `resourceGroup.resourceGroupId` | `resourceGroup.resourceGroupId` |
| - search | - | - | ✓ |
| **READ (single)** | ✓ | ✓ | ✓ |
| **CREATE** | ✓ | ✓ | ✓ |
| **UPDATE** | ✓ | ✓ | - |
| - where* | `tenantId`, `resourceGroupId` | `id`, `resourceGroup.resourceGroupId` | - |
| **UPSERT** | ✓ | ✓ | - |
| - where* | - | `id`, `resourceGroup.resourceGroupId` | - |
| **DELETE** | ✓ | ✓ | - |
| - where* | `tenantId`, `resourceGroupId` | `id`, `resourceGroup.resourceGroupId` | - |

\* Only simple equality checks against the listed properties are supported

Next to CRUD operations the following helper functions can be used:

```js
const aiCore = await cds.connect.to('AICore');
const {resourceGroups, deployments, configurations} = aiCore.entities;

// Fetch a resource group for a CDS tenant ID
const resourceGroupId = await aiCore.resourceGroupForTenant(cds.context.tenant)

// Call the RPT-1 API to fetch predictions - see AICoreService.cds for the schema
const predictions = await aiCore.predictRowColumns(/** RPT-1 payload */)

/**
 * Returns the deployment ID for RPT-1. If no RPT-1 deployment exists, creates one for the
 * resource group
*/
const rpt1DeploymentId = await aiCore.rpt1DeploymentId(resourceGroups, {resourceGroupId})

// Stops an AI Core deployment
await aiCore.stop(deployments, {id: '<deployment id>'})
```

## Requirements and Setup

To use the plugin in production scenarios you need an [SAP AI Core](https://help.sap.com/docs/sap-ai-core) service binding. The plugin will automatically create resource groups per tenant in multi-tenancy scenarios and create an RPT-1 deployment in each for the recommendations feature. In single-tenant setups the plugin uses the 'default' resource group and creates an RPT-1 deployment as well if none exists.

For single-tenant deployments you can change the resource group as follows:

```json
{
    "cds": {
        "requires": {
            "AICore": {
                "resourceGroup": "CUSTOM_SINGLE_TENANT_RESOURCE_GROUP"
            }
        }
    }
}
```

For Cloud Foundry apps an example config could look like this:

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


## Test the plugin locally

In `tests/bookshop-app/` you can find a sample application that is used to demonstrate how to use the plugin and to run tests against it.

### Local Testing

To execute local tests, simply run:

```bash
npm run test
```

For tests, the `cds-test` Plugin is used to spin up the application. More information about `cds-test` can be found [here](https://cap.cloud.sap/docs/node.js/cds-test).

For integration tests you need an AI Core binding.

```bash
cds bind ai-core -2 <your-ai-core-service-instance>
npm run test:hybrid
```

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/ai/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow our instructions [in our security policy](https://github.com/cap-js/ai/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and ai contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/ai).
