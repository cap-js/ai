# Model download progress demo

Run from the repository root with Node.js 20 or newer; no dependencies, credentials,
real model, or network connection are needed:

```sh
node samples/model-download-progress/demo.js --help
node samples/model-download-progress/demo.js
```

The default `healthy` scenario takes about eight seconds. On a terminal, the actual
CLI reporter updates one line with percentage, transferred bytes, rate, and ETA.
The second install reuses the verified cache without fetching again.

To see the CLI's plain milestone output instead, pipe stdout naturally:

```sh
node samples/model-download-progress/demo.js healthy | tee /tmp/model-progress.log
```

Other scenarios:

| Command argument | Expected behavior | Exit |
| --- | --- | --- |
| `startup` | Real `resolveEmbeddingModel` lookup warns that startup is blocked and logs throttled progress, then completes (~8s). | 0 |
| `stall` | Real CLI install receives one chunk, then fails after two seconds without another body chunk (~3s). The terminal status line is cleared before the error. | 1 |
| `headers` | Real CLI install never receives response headers and fails at the two-second idle limit. | 1 |
| `deadline` | Low-level `downloadFile` receives healthy chunks every 550ms but fails at its 2500ms absolute ceiling. | 1 |
| `legacy` | Same low-level download, using the compatibility `timeoutMs: 2500` option instead of `downloadTimeoutMs`. | 1 |
| `concurrent` | Two real `installModel` calls share one temporary cache. Both complete (~8s); each fixture is fetched only once. | 0 |

For example:

```sh
node samples/model-download-progress/demo.js stall
node samples/model-download-progress/demo.js concurrent
```

Timeout errors are intentional and printed to stderr. A successful download has a
two-second idle guard and a thirty-second per-file absolute ceiling, so the healthy
transfer lasts longer than the idle limit without failing. Piping through `tee`
normally reports `tee`'s exit code; run directly to inspect a failure's exit code.

## What this does and does not test

The sample imports this checkout's actual CLI, provisioning, model lookup, and
progress reporter implementations. `fetchImpl` returns paced in-memory streams;
discovery returns a synthetic descriptor with real size/checksum metadata. The
three artifacts are **not an ONNX model or a usable tokenizer**, and the sample
explicitly bypasses ONNX validation. It demonstrates progress, download guards,
integrity checking, and cache coordination, not inference or Hugging Face access.

Every invocation uses a fresh `mkdtemp` directory with an isolated project root
and fake home. Normal completion and timeout failures remove that directory in
`finally`; neither the checkout's model cache nor your `~/.cds/models` is touched.
Forced termination (for example, Ctrl+C) can leave the printed temporary directory
behind. Any cache reuse demonstrated here occurs only within that invocation.
