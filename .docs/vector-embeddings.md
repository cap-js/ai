# Local vector embeddings

> [!WARNING]
> Local vector embeddings, the SQLite extensions, local model management, and their CLI tooling are experimental and intended to improve local development. Breaking changes are expected. For production vector search and embeddings, use SAP HANA's vector engine.

`@cap-js/ai` does not add vector functionality to SAP HANA Cloud. HANA already provides vector storage, [`VECTOR_EMBEDDING`](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/vector-embedding-function-vector), and vector search natively. The SQLite implementation provides a similar development-time SQL shape, but it does not reproduce a HANA model or make locally generated vectors interchangeable with HANA-generated vectors.

## Database kinds and dependencies

`@cap-js/ai` redirects CAP's standard `sqlite` implementation instead of adding a separate database kind. With `@sap/cds` `^10.1`, the standard `sqlite:memory` preset inherits that implementation:

- `sqlite` uses a file-based SQLite database.
- `sqlite:memory` uses an in-memory SQLite database.

The redirect and synchronous embedding function require `@sap/cds` `^10.1` and `@cap-js/sqlite` `^3.1`. The package's other capabilities continue to support `@sap/cds` 9.

This applies to every SQLite service in an application that installs `@cap-js/ai`. Its embedding model is provisioned and initialized when the service starts, even if the application does not call `VECTOR_EMBEDDING`. SAP HANA services are unaffected.

Install the local development dependencies:

```sh
npm add -D @cap-js/sqlite@^3.1.0 @huggingface/hub \
  @huggingface/tokenizers onnxruntime-node
```

`@huggingface/hub` is needed for model discovery and provisioning.
`@huggingface/tokenizers` and `onnxruntime-node` are needed for inference.

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

The built-in runtime reads `model`, `directory`, `root`, `offline`, and `prompts`; additional properties are allowed for extensions.

Without `directory`, the runtime looks for the configured or default model below `<cds.root>/.cds/models/<owner>/<model>` first, then `~/.cds/models/<owner>/<model>`. When neither installation exists, startup prints a warning, downloads the model into the home cache while logging progress (percentage, downloaded/total, and an ETA), generates `embedding.lock.json`, and reuses it across projects. Automatic downloads and repairs never modify the project cache. Startup is blocked until the download finishes. Downloads use a stall timeout (no data received for a while) plus a generous absolute ceiling; if a download cannot finish, startup fails with guidance to provision the model ahead of time. For large models, prefer [explicit provisioning](#explicit-provisioning) so the download does not block startup.

An existing project model with missing or invalid metadata or artifacts causes an error instead of falling back to a different installation. Repair it explicitly with `install-model --directory .cds/models`. Invalid home artifacts can be repaired automatically using their valid lock; malformed or mismatched locks require explicit recovery.

The home cache uses Node.js's `os.homedir()`: typically `/Users/<user>/.cds/models` on macOS and `C:\Users\<user>\.cds\models` on Windows. No shell expansion of `~` is required for the default.

For a tool-owned SQLite service, set `embedding.root` to its model lookup root. It defaults to `cds.root`; an absolute path is used unchanged, and a relative path resolves from `cds.root`. This setting only selects the project-local model cache and anchors relative `embedding.directory` paths. It never changes `cds.root`, the application's database, or other services' configuration:

```js
const db = await cds.connect.to('tool-db', {
  kind: 'sqlite:memory',
  embedding: { root: toolRoot, model: 'owner/model' }
});
```

Set `embedding.offline: true` to preserve local-then-home lookup while forbidding model discovery, downloads, and repairs during startup. Missing or corrupt models cause an error with a provisioning command; an incomplete local override is not bypassed. Provision the model beforehand using the CLI or the API below. `offline` must be a boolean, and `root` must be a non-empty string. This policy concerns embedding-model I/O only; it does not disable other CAP services' network access.

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

Only use models from repositories you trust. Provisioning verifies artifact sizes and checksums, but these checks establish integrity, not whether a model is safe or appropriate for your application.

Provision the shared home model before startup:

```sh
npx @cap-js/ai install-model owner/model
```

The command installs into `~/.cds/models` by default. The same model can be reused across projects without additional configuration.

To provision a project-local override, select its cache root explicitly:

```sh
npx @cap-js/ai install-model owner/model --directory .cds/models
```

Relative directories resolve from the enclosing CAP project root, including when the command runs from a subdirectory. Absolute directories and quoted home-relative paths such as `--directory "~/.cds/models"` are also supported.

In an interactive terminal, the CLI shows a growing ASCII download bar with transferred bytes, rate, and ETA. Download completion is separate from ONNX Runtime validation; only a successful installation prints the final green status. Model identities are bold and cache paths are dim. `NO_COLOR` disables colors and emphasis. Piped output and `TERM=dumb` use plain milestone lines, and application startup logs stay plain and throttled.

To restrict runtime lookup to a pre-installed cache, configure `directory`:

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

`directory` is the cache root, so this example reads the artifacts below `~/.cds/models/owner/model`. Relative paths resolve from `embedding.root` (defaulting to `cds.root`), absolute paths remain absolute, and `~/` resolves from the user's home directory on macOS and Windows.

When `directory` is configured, startup treats it as a pre-installed cache. It validates the lock and files but does not download or modify them. Provision shared models in a controlled environment and consider making the directory read-only at runtime.

### Programmatic provisioning

Import the dedicated entrypoint to provision a model without registering CAP plugin hooks:

```js
import { installModel } from '@cap-js/ai/models.js';

const { model, modelDir, modelRoot } = await installModel('owner/model');
```

`installModel(repository, options?)` installs into the home cache by default, validates the lock, checksums, and ONNX runtime (including a probe inference), and returns the descriptor and absolute installation/cache-root paths. It reuses an existing valid lock and waits for concurrent provisioning of the same model. Invalid or mismatched locks require explicit recovery. Importing this entrypoint does not load CAP or inference dependencies; invoking the installer requires the provisioning and inference dependencies listed above.

`options.idleTimeoutMs` defaults to 60 seconds without receiving a chunk, and `options.downloadTimeoutMs` defaults to a 60-minute absolute ceiling per file. `options.onProgress` receives download progress events, a single `waiting` event when another installer owns the cache, and `validate:start`/`validate:done` events around the validation callback. Download `done` reports transfer completion, not runtime readiness; `validate:done` includes validation `elapsedMs` and model `dimensions`. Installation is complete only when the installer resolves after publication. `options.timeoutMs` separately limits waiting for another installer; it does not limit this installer's own downloads. The default wait budget covers every serial file's absolute ceiling plus 15 minutes for validation and publication. A non-positive `downloadTimeoutMs` disables the absolute download ceiling and the default wait deadline; an explicit `timeoutMs` still bounds waiting.

To provision a tool-local cache explicitly, use `await installModel('owner/model', { root: toolRoot, directory: '.cds/models' })`. `options.directory` is a cache root with the same absolute and home-relative path support as the CLI; `options.root` anchors relative directories and defaults to the current working directory. Without `directory`, `root` does not change the home destination. The `modelDir` return value identifies the model's directory, not the cache root, so do not pass it as `embedding.directory`.

## Compatibility check

Inspect repository metadata without downloading model weights:

```sh
npx @cap-js/ai check-model owner/model
```

This reports likely compatibility. `install-model` is definitive because it also downloads the artifacts, loads the ONNX model, verifies its inputs and output, and runs a probe inference.

The summary groups model metadata, embedding settings, and query/document prompts, and displays the full inspected revision. Green “Likely compatible” is a positive metadata result, not proof of runtime compatibility; the output explicitly states that no weights were downloaded and ONNX Runtime was not validated. Unsupported tasks are definite rejections. Missing metadata is shown as an amber incomplete inspection, not proven incompatibility. Both failures exit nonzero.

Prompt metadata is part of `embedding.lock.json`. Locks from earlier experimental versions that do not describe prompt semantics are rejected. Remove the affected model directory, then run `install-model` again to regenerate it.

See [Choosing a model](model-selection.md) for discovery filters and the supported model contract.

## SQL function

Use the HANA-shaped function from CQL or SQL:

```js
SELECT.from('Books').columns`
  VECTOR_EMBEDDING(title, 'DOCUMENT', 'SAP_GXY.20250407') as embedding
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
