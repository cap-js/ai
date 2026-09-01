# Local vector embeddings

> [!WARNING]
> Local vector embeddings, the SQLite extensions, local model management, and their CLI tooling are experimental and intended to improve local development. Breaking changes are expected. For production vector search and embeddings, use SAP HANA's vector engine.

`@cap-js/ai` does not add vector functionality to SAP HANA Cloud. HANA already provides vector storage, [`VECTOR_EMBEDDING`](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/vector-embedding-function-vector), and vector search natively. The SQLite implementation provides a similar development-time SQL shape, but it does not reproduce a HANA model or make locally generated vectors interchangeable with HANA-generated vectors.

## Database kinds and dependencies

`@cap-js/ai` redirects CAP's standard SQLite implementations instead of adding separate database kinds:

- `sqlite` uses a file-based SQLite database.
- `sqlite:memory` uses an in-memory SQLite database.

The redirect and synchronous embedding function require `@sap/cds` `^10.1` and `@cap-js/sqlite` `^3.1`. The package's other capabilities continue to support `@sap/cds` 9.

This applies to every SQLite service in an application that installs `@cap-js/ai`. Its embedding model is provisioned and initialized when the service starts, even if the application does not call `VECTOR_EMBEDDING`. SAP HANA services are unaffected.

Install the optional peers as development dependencies:

```sh
npm add -D @cap-js/sqlite@^3.1 @huggingface/hub@^2.15.0 \
  @huggingface/tokenizers@0.1.3 onnxruntime-node@1.20.1
```

`@huggingface/hub` is needed for model discovery and provisioning. `@huggingface/tokenizers` and `onnxruntime-node` are needed for inference. The exact ONNX Runtime version is currently required because synchronous SQLite functions use a version-specific native runtime interface.

## Configuration

Use the standard SQLite configuration:

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

The current default model is `sentence-transformers/all-MiniLM-L6-v2`. It was selected only because, at the time of selection, it was the most-downloaded reasonably small model matching the sentence-similarity task, ONNX format, and Apache-2.0 license filters used for the sample. This is not a model recommendation. The default may change at any time while the feature is experimental, so configure `embedding.model` explicitly when the model choice must remain stable:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlite",
        "embedding": {
          "model": "owner/model"
        }
      }
    }
  }
}
```

The built-in runtime reads `model` and the optional `directory`; additional properties are allowed for extensions.

Without `directory`, the configured or default model is stored below `<cds.root>/.cds/models/<owner>/<model>`. If a valid installation is absent, startup prints a warning, downloads the model, generates `embedding.lock.json`, and reuses it on later starts.

Use `sqlite:memory` when the application data itself need not survive a restart:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlite:memory"
      }
    }
  }
}
```

## Explicit provisioning

Provision the project-local model before startup:

```sh
npx @cap-js/ai install-model owner/model
```

The command finds the enclosing CAP project even when run from a subdirectory. It installs into `.cds/models` at the project root.

To reuse a model across projects, select a shared cache root:

```sh
npx @cap-js/ai install-model owner/model --directory ~/.cds/models
```

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlite",
        "embedding": {
          "model": "owner/model",
          "directory": "~/.cds/models"
        }
      }
    }
  }
}
```

`directory` is the cache root, so this example installs the artifacts below `~/.cds/models/owner/model`. Relative paths resolve from `cds.root`, absolute paths remain absolute, and `~/` resolves from the user's home directory.

When `directory` is configured, startup treats it as a pre-installed cache. It validates the lock and files but does not download or modify them. Provision shared models in a controlled environment and consider making the directory read-only at runtime.

## Compatibility check

Inspect repository metadata without downloading model weights:

```sh
npx @cap-js/ai check-model owner/model
```

This reports likely compatibility. `install-model` is definitive because it also downloads the artifacts, loads the ONNX model, verifies its inputs and output, and runs a probe inference.

Prompt metadata is part of `embedding.lock.json`. Locks from earlier experimental versions that do not describe prompt semantics are rejected. Remove the affected model directory, then run `install-model` again to regenerate it.

See [Choosing a model](model-selection.md) for discovery filters and the supported model contract.

## SQL function

Use the HANA-shaped function from CQL or SQL:

```js
SELECT.from('Books').columns`
  VECTOR_EMBEDDING(title, 'DOCUMENT', 'local') as embedding
`;
```

The service accepts both the three-argument form and a four-argument form with `remote_source`:

```sql
VECTOR_EMBEDDING(text, text_type, model_and_version)
VECTOR_EMBEDDING(text, text_type, model_and_version, remote_source)
```

`text` is embedded. For models trained with query/document prompts, `text_type` applies the compatible prefix discovered from the model metadata. No additional configuration is normally needed, and `check-model` displays the detected mapping.

If required prompts are not available in model metadata, configure them explicitly:

```json
{
  "embedding": {
    "model": "owner/model",
    "prompts": {
      "query": "search_query: ",
      "document": "search_document: "
    }
  }
}
```

Configured `embedding.prompts` entries override the corresponding discovered entry; omitted entries continue using discovered metadata. For models with `include_prompt=false`, this runtime cannot apply discovered or configured prompts; For models that were not trained with prompts, prompt-free use is supported.
`model_and_version` and `remote_source` preserve the SQL shape for development compatibility but do not affect local inference.
SQL `NULL` returns `NULL`, and empty or whitespace-only text is treated as no value and returns a zero vector.
The result is a JSON string containing the model's vector dimensions.

## Runtime behavior

SQLite user-defined functions cannot await. Tokenization, inference, pooling, and normalization therefore run synchronously and block the Node.js event loop for each call. This tradeoff is acceptable only for local development and low-volume experiments.

Each invocation embeds the first model input window. Longer input is truncated. Split long documents before persistence and store one vector per chunk when retrieval must cover the full text.

## Provisioning and trust boundary

Discovery resolves the repository to an immutable commit and generates an `embedding.lock.json` containing the selected artifacts, dimensions, input limit, pooling, normalization, sizes, and SHA-256 checksums. Downloads use bounded responses, timeouts, retries for transient failures, and size/checksum validation. Existing installations are checked for file changes before use.

This is trust on first use, not publisher authentication. The initial installation trusts the selected public Hugging Face repository and its metadata. A self-consistent lock does not make an untrusted model safe. Installation loads the tokenizer and ONNX graph into native libraries and executes a probe in the current process. Use repositories you trust and prefer explicit provisioning in a controlled environment.

Provisioning rejects symlinked model paths and unsafe artifact names. Conventional ONNX external-data sidecars adjacent to the selected graph are supported; arbitrary paths encoded in the ONNX protobuf are not.
