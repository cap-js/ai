# SAP Cloud Application Programming Model, AI plugin for Node.js

The SAP Cloud Application Programming Model, AI plugin for Node.js bundles a variety of AI capabilities to infuse into your CAP applications:
1. Recommendations
2. Simplified Embeddings
3. Simplified AI Core usage

> [!IMPORTANT]
> In multi tenancy scenarios with a sidecar the plugin must be included in the sidecar for SAP AI Core handling.

## 1. Recommendations

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

## 2. Simplified embeddings

For natural language processing it is crucial to embed text data into a Vector. HANA Cloud offers a `VECTOR_EMBEDDING` function via which an embedding can be generated. The model which can be specified can either be an SAP model, when [HANA Cloud NLP](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-nlp-51eb170d038d4099a9bbb85c08fda888?locale=en-US) is enabled or a [model provided in SAP AI Core](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-sap-ai-core?locale=en-US), like the ones from OpenAI or AWS.

> [!HINT]
> cds.Vector support and standardized vector functions on other databases is work in progress. You can use the `cap-js-sqlite-2.1.3.tgz` file as part of this plugin to already try out the sqlite support. HANA Cloud functions like `vector_embedding`, `cosine_similarity`, `l2distance` or `cardinality` will work with this as well on SQLite.

Use `@ai.embedding` and `@ai.embedding.@ai.model` to easily generate a vector column and automatically fill it with embeddings. The default model used is 'SAP_GXY.20250407' but can be overridden via `cds.env.ai.embeddings.defaultModel`.

```cds
entity Books {
  key ID : Integer;
  title  : String(111);
  @ai.embedding
  descr  : String(1111);
}
```

```cds
entity Books {
  key ID : Integer;
  title  : String(111);
  @ai.embedding
  @ai.embedding.@ai.model : 'amazon--titan-embed-text."1.2"'
  descr  : String(1111);
}
```

HANA Cloud has native models for text embedding when their Natural Language Processing feature is enabled: `SAP_GXY.20250407` and `SAP_NEB.20240715`. However HANA Cloud can also be connected to AI Core via a remote source, and then embedding models from OpenAI and AWS can be used as well.

Because the remote source needs to be referenced within the `VECTOR_EMBEDDING` function, but the syntax is invalid within CAP, the plugin automatically adds the configured remote source, when the model is not from SAP. The default remote source is `AI_CORE` but it can be overridden via `cds.env.ai.embeddings.remoteSource`.

Behind the scenes the annotations will generate a column similar to this:

```cds
entity Books {
  key ID : Integer;
  title  : String(111);
  descr  : String(1111);
  embedding : Vector = (VECTOR_EMBEDDING(descr, 'DOCUMENT', 'amazon--titan-embed-text."1.2"')) stored;
}
```

> [!INFO]
> The fourth parameter is the remote source in HANA Cloud which is mandatory for models provided by SAP AI Core. The plugin will automatically fill it with the default remote source `cds.env.ai.embeddings.remoteSource` if the parameter is not provided.

### Using non SAP models for embeddings with SAP HANA Cloud

Currently the setup is not ideal when models provided by SAP AI Core shall be used. You have to complete the following steps to get it to work:

1. Follow the [Creating Text Embeddings with SAP AI Core](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-sap-ai-core?locale=en-US) documentation in SAP Help.
2. After creating the PSE and the remote source in HANA Cloud, you need to grant the privileges for referencing the remote source to a user, which in turn can grant it to the HDI user for your CAP application. The following SQL creates a user group which can send requests to the remote source, creates a user and grants the user permissions to grant other users permissions to send requests to the remote source.

    ```sql
    CREATE ROLEGROUP HDI_GRANTOR_GROUP;

    CREATE ROLE HC_REMOTESOURCE_GRANTOR SET ROLEGROUP HDI_GRANTOR_GROUP;

    GRANT EXECUTE ON REMOTE SOURCE <REMOTE_SOURCE_NAME> TO HC_REMOTESOURCE_GRANTOR WITH GRANT OPTION;

    -- Choose a unique password
    ALTER USER HDI_GRANT_USER PASSWORD <password_for_user> NO FORCE_FIRST_PASSWORD_CHANGE;
    GRANT HC_REMOTESOURCE_GRANTOR TO HDI_GRANT_USER WITH GRANT OPTION;
    ```
3. Create a user provided service on BTP with the credentials for the user:

    ```ssh
    cf cups hana_ai -p '{"username":"HDI_GRANT_USER","password":"<password_for_user>", "tags": ["hana"]}'
    ```
4. Create an `.hdbgrants` file in `db/src`. HDI will pick this up during deployment and use the permissions of the user to grant its permissions to the HDI users.

    ```json
    {
    "hana_ai": {   
        "object_owner": {
            "roles": [
                "HC_REMOTESOURCE_GRANTOR"          
            ]
        },
        "application_user": {
            "roles": [
                "HC_REMOTESOURCE_GRANTOR"
            ]
        }
    }
    }
    ```

> [!WARNING]
> In Multi-Tenancy scenarios you would have to create a remote source per tenant and assign the reference privilege to the respective tenant binding. The remote source per tenant should be done because in AI Core each tenant should have a different resource group for isolation.

### Similarity search

When a property is annotated with `@ai.embedding`, searching on the entity will no longer do a regular string based search, but instead use a cosine similarity search leveraging the embedding for that property.

The fuzziness threshold will be used as the threshold for similarity as well. You can change the threshold via `@Search.fuzzinessThreshold`.

```cds
entity Books {
    key ID : Integer;
    @ai.embedding
    @Search.fuzzinessThreshold: 0.5
    description                  : String(1111);
}
```

## 3. Simplified AI Core usage

The plugin introduces an `AICore` CAP service via which automatically performs some administrative tasks and offers a simplified AI Core access. 

### Automatic operations

- The plugin automatically creates a new SAP AI Core resource group per tenant during tenant onboarding and deletes it during offboarding.
- The plugin automatically creates an RPT-1 deployment per resource group for the recommendations feature.

### Simplified AI Core API access

```js
const aiCore = await cds.connect.to('AICore');
const {resourceGroups, deployments, configurations} = aiCore.entities;
const resourceGroups = await aiCore.run(SELECT.from(resourceGroups));
await aiCore.run(SELECT.from(resourceGroups).where({tenantId: cds.context.tenantId}));
await aiCore.run(SELECT.from(deployments).where({'resourceGroup.resourceGroupId': resourceGroups[0].resourceGroupId}));
await aiCore.run(SELECT.from(configurations).where({'resourceGroup.resourceGroupId': resourceGroups[0].resourceGroupId}));

// Fetch a resource group for a CDS tenant ID
await aiCore.resourceGroupForTenant(cds.context.tenant)
```

Currently the following `cds.ql` operations are supported:

| Operation | resourceGroups | deployments | configurations |
|-----------|---------------|-------------|----------------|
| **READ (list)** | ✓ | ✓ | ✓ |
| - limit | ✓ | ✓ | ✓ |
| - where* | `tenantId`, `resourceGroupId` | `resourceGroup.resourceGroupId` | `resourceGroup.resourceGroupId` |
| - search | - | - | ✓ |
| **READ (single)** | ✓ | ✓ | ✓ |
| **CREATE** | ✓ | ✓ | - |
| **UPDATE** | ✓ | ✓ | - |
| - where* | `tenantId`, `resourceGroupId` | `id`, `resourceGroup.resourceGroupId` | - |
| **UPSERT** | ✓ | ✓ | - |
| - where* | - | `id`, `resourceGroup.resourceGroupId` | - |
| **DELETE** | ✓ | - | - |

\* Only simple equality checks against the listed properties are supported

Next to CRUD operations the following helper functions can be used:

```js
const aiCore = await cds.connect.to('AICore');
const {resourceGroups, deployments, configurations} = aiCore.entities;

// Fetch a resource group for a CDS tenant ID
const resourceGroupId = await aiCore.resourceGroupForTenant(cds.context.tenant)

// Call the RPT-1 API to fetch predictions - see AICoreService.cds for the schema
const resourceGroupId = await aiCore.predictRowColumns(/** RPT-1 payload */)

/**
 * Returns the resource group If no RPT-1 deployment exists, creates one for the
 * resource group
*/
const rpt1DeploymentId = await aiCore.rpt1DeploymentId(resourceGroups, {resourceGroupId})

/**
 * Stop an AI Core deployment
 */
await aiCore.stop(deployments, {id: '<deployment id'})
```