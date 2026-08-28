[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/ai)](https://api.reuse.software/info/github.com/cap-js/ai)

# SAP Cloud Application Programming Model, AI plugin for Node.js

## About this project

The SAP Cloud Application Programming Model, AI plugin for Node.js bundles two AI capabilities to infuse into your CAP applications:
1. UI Recommendations
2. Simplified AI Core usage

> [!IMPORTANT]
> In multi tenancy scenarios with a sidecar the plugin must be included in the sidecar for SAP AI Core handling.

### 1. Use case: Recommendations

Recommendations are implemented leveraging [SAP-RPT-1](https://help.sap.com/docs/sap-ai-core/generative-ai/sap-rpt-1) and AI Core. This plugin generically hooks into any entity which has properties with a value help (detected via `@Common.ValueList` on the property or `@cds.odata.valuelist` on the association target).

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

#### Regression Recommendations on fields without a value help

By default, the plugin only enhances fields that have a value help list since these columns are good prediction targets for classification. However, some fields are good targets but have no value list: free-form numerics like measurement ranges, calibration values, or planning estimates. Annotate these with `@UI.RecommendationState` to opt in:

```cds
entity CalibrationData : cuid {
  measuringRangeMin : Decimal(16, 6) @UI.RecommendationState;
  measuringRangeMax : Decimal(16, 6) @UI.RecommendationState;
  operatingPoint    : Decimal(16, 6) @UI.RecommendationState;
  description       : String         @UI.RecommendationState;
}
```

The annotation only takes effect on **scalar** elements (no associations / compositions / unmanaged elements; for those, attach a value help instead). Annotated fields are added to the entity's `<Entity>_Recommendations` companion just like value-helped fields, and Fiori Elements' soft-fill placeholder renders the prediction in the empty input.

`task_type` is chosen automatically per column:
- numeric scalar (`Integer*`, `Decimal`, `Double`) annotated with `@UI.RecommendationState` → **`regression`** so RPT-1 can interpolate continuous values,
- everything else → **`classification`**.

> [!NOTE]
> Numeric fields that have a value help (e.g. a fixed price-point list) stay on classification — `@UI.RecommendationState` is only needed when there is *no* value help. Combining both is unnecessary.

> [!WARNING]
> SAP Fiori Elements does not yet support rendering recommendations for scalar fields without a value help. The backend correctly provides predictions for these fields, but the Fiori Elements client currently only requests and displays recommendations for fields annotated with `@Common.ValueList` or `@Common.ValueListWithFixedValues`.

<details>
<summary><b>How recommendations work under the hood</b></summary>

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

</details>

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

### 3. Local Vector Embeddings with SQLite

The beta AI-enabled SQLite database kinds extend `@cap-js/sqlite` with local semantic embeddings using an ONNX encoder model:

- `ai-sqlite` uses a file-based SQLite database.
- `ai-sqlite:memory` uses an in-memory SQLite database.

Configure the embedding model explicitly for every service.

#### Usage

Install the optional peer dependencies as development dependencies:

```sh
npm add -D @cap-js/sqlite @huggingface/hub@^2.15.0 @huggingface/tokenizers@0.1.3 onnxruntime-node@1.20.1 oxigraph
```

These packages are optional peer dependencies of `@cap-js/ai` and are required only for the corresponding local SQLite capabilities. `@huggingface/hub` is required for explicit or ad-hoc model provisioning. Both database kinds currently require exactly `onnxruntime-node` 1.20.1 because synchronous SQLite functions need a version-specific native runtime API.

Tokenization, ONNX inference, pooling, and normalization run synchronously for each `VECTOR_EMBEDDING` call. SQLite user-defined functions cannot await, so inference blocks the Node.js event loop until it completes. The feature is intended for local development and low-volume use; server workloads should precompute or batch embeddings outside SQL.

#### Model provisioning

The built-in embedding runtime reads a model name and an optional model-cache root:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "ai-sqlite",
        "embedding": {
          "model": "foo/bar"
        }
      }
    }
  }
}
```

This configuration uses a file-based SQLite database. For an in-memory database, change the kind to `ai-sqlite:memory`; no `credentials.url` is required:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "ai-sqlite:memory",
        "embedding": {
          "model": "foo/bar"
        }
      }
    }
  }
}
```

`embedding.model` is required. If it is absent, either kind fails during startup. Additional properties are allowed so extensions can add configuration of their own; built-in model provisioning only reads `model` and `directory`.

Without `directory`, the model is stored below the CAP project at `.cds/models/foo/bar`. Startup reuses a valid installation from there. If it is missing, startup logs a warning, discovers and downloads the model, generates `embedding.lock.json`, and reuses that installation on subsequent starts.

Only install models from repositories you trust. Provisioning is trust-on-first-use: the first download trusts the named repository and its Hugging Face metadata, then pins the resolved revision, sizes, and checksums in `embedding.lock.json`. Subsequent starts detect local corruption or repository drift, but the lock does not authenticate the publisher or make an untrusted model safe. Provisioning loads the downloaded tokenizer and ONNX graph into the native runtime and executes a startup probe in the current process.

To provision the project-local model before startup instead:

```sh
npx @cap-js/ai install-model foo/bar
```

The command locates the enclosing CAP project and uses its root for `.cds/models` and relative `--directory` values, even when invoked from a project subdirectory.

To check whether a Hugging Face repository is likely compatible before downloading it:

```sh
npx @cap-js/ai check-model foo/bar
```

`check-model` only reads repository, configuration, and tokenizer metadata from the Hub. It does not download the ONNX artifact or write to the model cache. Its result is therefore a likely-compatibility check; `install-model` is definitive because it also loads and probes the downloaded model with ONNX Runtime.

To share a model across projects, select another cache root:

```sh
npx @cap-js/ai install-model foo/bar --directory ~/.cds/models
```

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "ai-sqlite",
        "embedding": {
          "model": "foo/bar",
          "directory": "~/.cds/models"
        }
      }
    }
  }
}
```

`directory` always names the cache root; the model is stored below it using the repository path, for example `~/.cds/models/foo/bar`. Relative directories are resolved from `cds.root`, absolute directories are used unchanged, and `~/` is resolved from the user's home directory.

When `directory` is configured, startup treats it as a pre-installed shared cache: it checks the pinned files but does not download or modify them. Provision models in a trusted build environment, retain the generated lock, and make the shared directory read-only at runtime.

##### Automatic model discovery

The installer uses the official Hugging Face Hub client to resolve the model's current revision to an immutable commit, enumerate its files, and retrieve discovery metadata. Selected artifacts are then streamed into the model cache with integrity checks. Model discovery and installation currently support public repositories only. The resolved lock contains the commit, artifact paths, sizes, checksums, dimensions, tokenizer limit, pooling, and normalization metadata; it is written to `embedding.lock.json` alongside the downloaded artifacts. Hub requests use bounded timeouts and retry transient network and server failures.

Discovery is layout-aware rather than tied to one exporter. It prefers `onnx/model.onnx`, then `model.onnx`, a unique nested `model.onnx`, or a sole ONNX file. For a nested model it prefers adjacent tokenizer/configuration files and falls back to repository-root files. Common Transformers configuration names for dimensions (`hidden_size`, `n_embd`, `d_model`, and `dim`) and input length are recognized.

The downloaded ONNX model is loaded and probed with ONNX Runtime before it is accepted. This verifies that its inputs, output shape, element type, and dimensions work as an embedding model, so a decoder's logits graph cannot accidentally be installed as one. Discovery also rejects repositories explicitly tagged for incompatible tasks such as text generation or masked-language modeling. Once installed, startup uses the pinned lock and does not follow later changes to the model repository.

The HANA-compatible SQL function can then be used in CQL:

```js
SELECT.from('Books').columns`
  VECTOR_EMBEDDING(title, 'DOCUMENT', 'SAP_GXY.20250407') as embedding
`;
```

`VECTOR_EMBEDDING` embeds one model input window. Text beyond the tokenizer's input limit is truncated. For long-document retrieval, split documents before persistence and store one vector per chunk instead of combining chunk embeddings in this function. Each invocation performs synchronous inference and blocks the Node.js event loop while it runs.

**Parameters:**

- `text` - Text to embed (`NULL` remains `NULL`; empty text returns a zero vector)
- `text_type` - Type of text, e.g., `'DOCUMENT'` (currently informational)
- `model_and_version` - Compatibility model identifier, e.g., `'SAP_GXY.20250407'` or `'SAP_GXY.20240715'` (currently informational; the service's `embedding` option selects the local model)

**Returns:**

- JSON stringified array of embedding values with the configured model's dimensions

**Features:**

- **Initialization**: The ONNX model is loaded when the AI-enabled SQLite service starts
- **Automatic provisioning**: Use model-only configuration for warned, on-demand installation into `.cds/models`
- **Explicit provisioning**: Preinstall local or shared models with `npx @cap-js/ai install-model`
- **Pinned artifacts**: The provisioned lock pins the revision, artifact sizes, and SHA-256 checksums for later local integrity checks
- **Compatibility pre-check**: Use `npx @cap-js/ai check-model <model>` to inspect a repository without downloading model weights
- **Hugging Face tokenization**: Uses `@huggingface/tokenizers` and truncates text to the first model input window
- **Deterministic**: Same input always produces same output
- **Automatic output handling**: Pooling and normalization are derived from Sentence Transformers metadata
- **Semantic similarity**: Embeddings capture text meaning for similarity search

#### Compatible encoder models

The Hugging Face `onnx` library filter is a useful starting point, but it is not sufficient: it also includes decoder and masked-language-model exports, which do not produce sentence embeddings. A compatible repository needs a tokenizer JSON and configuration, a single discoverable ONNX encoder graph, and a usable embedding contract.

For candidate discovery, start with the [trending Hugging Face sentence-similarity ONNX models](https://huggingface.co/models?pipeline_tag=sentence-similarity&library=onnx&sort=trending) and run `npx @cap-js/ai check-model <model>`. Adding the [`sentence-transformers` tag](https://huggingface.co/models?pipeline_tag=sentence-similarity&library=onnx&other=sentence-transformers) narrows the list toward repositories with machine-readable pooling metadata. The Hub filters and the check command identify likely candidates only; always use `install-model` before deploying a model.

The graph must accept `input_ids` and may additionally accept `attention_mask` and `token_type_ids`; all inputs must be rank-2 `int64` tensors. Token-level outputs used with pooling must be floating-point rank-3 tensors whose final dimension matches the model configuration. The runtime requires an unambiguous Sentence Transformers pooling pipeline. Pooling semantics are read from `modules.json` and its pooling configuration. Converted repositories such as `Xenova/*` can declare a single `base_model`; its immutable Sentence Transformers metadata is used to determine mean or CLS pooling and normalization. Unsupported module chains, ambiguous pooling modes, missing metadata, incompatible ONNX inputs or outputs, and explicitly incompatible Hub tasks fail with a compatibility error instead of using guessed defaults.

External ONNX tensor data is supported only for conventional files next to the selected graph: `<model>.onnx_data`, `<model>.onnx.data`, or numbered `<model>.onnx.data.*` sidecars. Discovery does not parse arbitrary `external_data` references from the ONNX protobuf, so repositories using other sidecar names are rejected.

Provisioning canonicalizes symlinked parent directories and rejects a model directory that is itself a symlink. Existing valid locks remain pinned and are reused rather than silently following changes to the repository's default branch.

**Error Handling:**

- Starting either AI-enabled SQLite kind fails if `cds.env.requires.db.embedding.model` is not set or the ONNX model cannot be initialized
- A missing model in the project-local `.cds/models` cache is installed after a startup warning
- Starting either AI-enabled SQLite kind fails with a provisioning command if a configured model directory is missing or fails integrity checks
- Provisioning downloads are time-limited and accepted only when their expected size and SHA-256 match
- Throws if embedding generation fails

#### Experimental local knowledge graph

Both AI-enabled SQLite kinds expose a process-local Oxigraph store through `SPARQL_EXECUTE` and `sparql_table`.

The supported procedure-compatible form is:

```sql
CALL SPARQL_EXECUTE('<SPARQL>', '<headers>', ?, ?)
```

The final two `?` tokens are required HANA-compatible output placeholders, not input bindings. The local implementation accepts literal SPARQL and header strings only. Query operations return an object with a serialized `RESPONSE`; `LOAD` returns no result. This is a compatibility shim rather than a general stored-procedure implementation.

The Oxigraph store is in memory and tied to the service connection. Its triples are lost on disconnect or process restart, including when `ai-sqlite` uses a file-based SQLite database, and its updates are not transactionally coupled to SQLite.

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
