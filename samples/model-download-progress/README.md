# Model download progress demo

Run from the repository root with Node.js 20 or newer; no dependencies, credentials,
real model, or network connection are needed:

```sh
node samples/model-download-progress/demo.js --help
node samples/model-download-progress/demo.js
```

The default `healthy` scenario takes about eight seconds. On a terminal, the actual
CLI reporter updates one ASCII bar with percentage, transferred bytes, rate, and
ETA. Identity is bold, cache paths are dim, and the final status is green. Download
completion and the validation stage are shown separately. The second install
reuses the verified cache without fetching again.

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
| `check` | Real `check-model` metadata inspection shows grouped facts and green “Likely compatible,” without downloading weights. | 0 |
| `unsupported` | Real metadata inspection rejects a `text-generation` task, with a red error and no installation bypass. | 1 |
| `incomplete` | Real metadata inspection cannot determine dimensions; the amber error says compatibility is unknown. | 1 |

For example:

```sh
node samples/model-download-progress/demo.js stall
node samples/model-download-progress/demo.js concurrent
node samples/model-download-progress/demo.js check
node samples/model-download-progress/demo.js unsupported
node samples/model-download-progress/demo.js incomplete
NO_COLOR=1 node samples/model-download-progress/demo.js check
```

Colors follow your terminal palette. `NO_COLOR` disables colors and emphasis;
redirected output and `TERM=dumb` use only plain milestones with no animation.
The concurrent scenario prints one wait message for the contending installer rather
than a message for each retry.

Timeout errors are intentional and printed to stderr. A successful download has a
two-second idle guard and a thirty-second per-file absolute ceiling, so the healthy
transfer lasts longer than the idle limit without failing. Piping through `tee`
normally reports `tee`'s exit code; run directly to inspect a failure's exit code.

## What this does and does not test

The sample imports this checkout's actual CLI, provisioning, model lookup, and
progress reporter implementations. `fetchImpl` returns paced in-memory streams;
install discovery returns a synthetic descriptor with real size/checksum metadata.
The three `check-model` scenarios inspect in-memory repository metadata through
the actual discovery code, with no artifact download. The
three artifacts are **not an ONNX model or a usable tokenizer**, and the sample
explicitly bypasses ONNX validation. It demonstrates progress, download guards,
integrity checking, metadata inspection, and cache coordination, not inference or
Hugging Face access. Its validation callback adds a short delay so you can see the
separate validation stage; the banner remains explicit that no real validation is
performed and the artifacts are not usable.

Every invocation uses a fresh `mkdtemp` directory with an isolated project root
and fake home. Normal completion and timeout failures remove that directory in
`finally`; neither the checkout's model cache nor your `~/.cds/models` is touched.
Forced termination (for example, Ctrl+C) can leave the printed temporary directory
behind. Any cache reuse demonstrated here occurs only within that invocation.
