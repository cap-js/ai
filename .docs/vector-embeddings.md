# Local vector embeddings

> [!WARNING]
> Local vector embeddings, the AI-enabled SQLite kinds, local model management, and their CLI tooling are experimental and intended to improve local development. Breaking changes are expected. For production vector search and embeddings, use SAP HANA's vector engine.

## Database kinds and dependencies

- `ai-sqlite` uses a file-based SQLite database.
- `ai-sqlite:memory` uses an in-memory SQLite database.

Install the optional peers as development dependencies:

```sh
npm add -D @cap-js/sqlite @huggingface/hub@^2.15.0 \
  @huggingface/tokenizers@0.1.3 onnxruntime-node@1.20.1
```

`@huggingface/hub` is needed for model discovery and provisioning. `@huggingface/tokenizers` and `onnxruntime-node` are needed for inference. The exact ONNX Runtime version is currently required because synchronous SQLite functions use a version-specific native runtime interface.

## Configuration

Every AI-enabled SQLite service requires a model; there is no default:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "ai-sqlite",
        "embedding": {
          "model": "owner/model"
        }
      }
    }
  }
}
```

Startup fails if `cds.requires.db.embedding.model` is missing. The built-in runtime reads `model` and the optional `directory`; additional properties are allowed for extensions.

Without `directory`, models are stored below `<cds.root>/.cds/models/<owner>/<model>`. If a valid installation is absent, startup prints a warning, downloads the model, generates `embedding.lock.json`, and reuses it on later starts.

Use `ai-sqlite:memory` when the application data itself need not survive a restart:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "ai-sqlite:memory",
        "embedding": {
          "model": "owner/model"
        }
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
        "kind": "ai-sqlite",
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

Only `text` affects local inference today. `text_type`, `model_and_version`, and `remote_source` preserve the SQL shape for development compatibility; `embedding.model` selects the actual local model. SQL `NULL` remains `NULL`, while empty text returns a zero vector. The result is a JSON string containing the model's vector dimensions.

## Runtime behavior

SQLite user-defined functions cannot await. Tokenization, inference, pooling, and normalization therefore run synchronously and block the Node.js event loop for each call. This tradeoff is acceptable only for local development and low-volume experiments.

Each invocation embeds the first model input window. Longer input is truncated. Split long documents before persistence and store one vector per chunk when retrieval must cover the full text.

## Provisioning and trust boundary

Discovery resolves the repository to an immutable commit and generates an `embedding.lock.json` containing the selected artifacts, dimensions, input limit, pooling, normalization, sizes, and SHA-256 checksums. Downloads use bounded responses, timeouts, retries for transient failures, and size/checksum validation. Existing installations are checked for file changes before use.

This is trust on first use, not publisher authentication. The initial installation trusts the selected public Hugging Face repository and its metadata. A self-consistent lock does not make an untrusted model safe. Installation loads the tokenizer and ONNX graph into native libraries and executes a probe in the current process. Use repositories you trust and prefer explicit provisioning in a controlled environment.

Provisioning rejects symlinked model paths and unsafe artifact names. Conventional ONNX external-data sidecars adjacent to the selected graph are supported; arbitrary paths encoded in the ONNX protobuf are not.
