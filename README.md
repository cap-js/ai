[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/ai)](https://api.reuse.software/info/github.com/cap-js/ai)

# CAP AI plugin for Node.js

`@cap-js/ai` adds UI recommendations powered by SAP AI Core, simplified access to SAP AI Core resources, and vector embedding support for CAP applications.

## Recommendations

The plugin adds SAP-RPT-1 recommendations to draft-enabled entities. Fields with a value help are included automatically:

```cds
@odata.draft.enabled
entity Books {
  key ID    : Integer;
      title : String;
      genre : Association to Genres;
      price : Decimal;
}

annotate Genres with @cds.odata.valuelist;
```

![Recommendations as default values](./_assets/recommendation-default.png)

Use `@UI.RecommendationState` to opt individual fields in or out:

```cds
annotate Books with {
  genre @UI.RecommendationState: 0;
  price @UI.RecommendationState;
}
```

A production deployment requires an [SAP AI Core](https://help.sap.com/docs/sap-ai-core) service binding. Without one, local development uses a mock implementation for UI smoke tests. See [Recommendations](.docs/recommendations.md) for regression targets, request behavior, data handling, and deployment lifecycle.

## SAP AI Core

The plugin provides an `AICore` CAP service for managing resource groups, deployments, and configurations:

```js
const aiCore = await cds.connect.to('AICore');
const { resourceGroups, deployments } = aiCore.entities;

const groups = await aiCore.run(SELECT.from(resourceGroups));
await aiCore.stop(deployments, { id: '<deployment id>' });
```

See [SAP AI Core integration](.docs/ai-core.md) for setup, supported queries, helper methods, and multitenancy.

## Local vector embeddings with SQLite (experimental)

> [!WARNING]
> The SQLite extensions, local vector embeddings, local model management, and the related tooling are experimental facilities for local development. Breaking changes are expected, including changes caused by SQLite's synchronous function interface and by local model management. Use SAP HANA's vector engine for production vector workloads.

Here is a complete Bookshop example.

1. Install the local-development dependencies:

   ```sh
   npm add -D @cap-js/ai @cap-js/sqlite@^3.1 @huggingface/hub@^2.15.0 \
     @huggingface/tokenizers@0.1.3 onnxruntime-node@1.20.1
   ```

   Local vector embeddings require `@sap/cds` `^10.1` and `@cap-js/sqlite` `^3.1`; the package's other capabilities continue to support `@sap/cds` 9.

2. Use the standard SQLite service. Most CAP projects already do this in development; an explicit configuration looks like this:

   ```json
   {
     "cds": {
       "requires": {
         "db": {
           "kind": "sqlite"
         }
       }
     }
   }
   ```

3. Add an embedding preview to the Bookshop service. In its service implementation, which imports `cds` from `@sap/cds`:

   ```cds
   function embedding(text : String) returns LargeString;
   ```

   ```js
   this.on('embedding', async (req) => {
     const [row] = await cds.db.run(
       `SELECT VECTOR_EMBEDDING(?, 'DOCUMENT', 'local') AS embedding`,
       [req.data.text]
     );
     return row.embedding;
   });
   ```

4. Start the application and call the function:

   ```sh
   cds w
   ```

   In another terminal:

   ```sh
   curl 'http://localhost:4004/odata/v4/catalog/embedding(text=%27A%20book%20about%20travel%27)'
   ```

`@cap-js/ai` redirects the standard `sqlite` and `sqlite:memory` implementations to add the local capabilities. The first start warns that the default model is missing, downloads it to `.cds/models`, and then initializes it. The response's `value` contains a JSON-encoded vector with 384 numbers. Later starts reuse the installed model.

The current default is [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). It was selected only because, at the time of selection, it was the most-downloaded reasonably small model matching the sentence-similarity task, ONNX format, and Apache-2.0 license filters below. This is not a recommendation, and the default may change at any time while this feature is experimental. Configure `cds.requires.db.embedding.model` explicitly if the choice must remain stable.

Start model discovery with [trending Apache-2.0 sentence-similarity models that provide ONNX artifacts](https://huggingface.co/models?pipeline_tag=sentence-similarity&library=onnx&license=license:apache-2.0&sort=trending). These filters select a relevant task, a locally runnable format, and a permissive license, but they do not guarantee compatibility. Choose a model as big as necessary and as small as possible, then validate it with the provided tooling.

See [Choosing a model](.docs/model-selection.md) and [Local vector embeddings](.docs/vector-embeddings.md) for compatibility checks, explicit or shared provisioning, runtime behavior, and limitations.

## Advanced

- [Recommendations](.docs/recommendations.md) — generated service shape, prediction context, regression targets, and lifecycle
- [SAP AI Core integration](.docs/ai-core.md) — bindings, multitenancy, supported operations, and helper methods
- [Local vector embeddings](.docs/vector-embeddings.md) — SQLite kinds, model provisioning, SQL function behavior, and trust boundaries
- [Choosing a model](.docs/model-selection.md) — Hugging Face filters, compatibility requirements, and size tradeoffs
- [Local knowledge graph](.docs/knowledge-graph.md) — experimental `SPARQL_EXECUTE` and `sparql_table` support

## Test the plugin locally

The sample application is in `tests/bookshop`.

```sh
npm test
```

Integration tests require an SAP AI Core binding:

```sh
cds bind ai-core -2 <your-ai-core-service-instance>
npm run test:hybrid
```

## Support, feedback, and contributing

This project welcomes feature requests, bug reports, and contributions through [GitHub issues](https://github.com/cap-js/ai/issues). See the [Contribution Guidelines](CONTRIBUTING.md) for development information.

## Security

Report potential security issues through the project's [security policy](https://github.com/cap-js/ai/security/policy), not through public issues.

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md).

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and ai contributors. See [LICENSE](LICENSE) and the [REUSE report](https://api.reuse.software/info/github.com/cap-js/ai).
