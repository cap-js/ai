# Choosing a local embedding model

> [!WARNING]
> Local model execution and provisioning are experimental development features. A model that installs successfully is not automatically appropriate for an application's data, languages, or quality requirements.

## Start with a focused list

Use the [trending Apache-2.0 sentence-similarity models with ONNX artifacts](https://huggingface.co/models?pipeline_tag=sentence-similarity&library=onnx&license=license:apache-2.0&sort=trending) as a discovery starting point:

- `sentence-similarity` favors sentence-level semantic embeddings rather than text generation or token classification.
- `onnx` indicates that the repository advertises an ONNX export that can potentially run locally.
- `apache-2.0` narrows the list to a permissive license commonly suitable for experimentation. Always review the model card and license for your own use.
- `trending` makes active, commonly used candidates easier to find; it is not a quality ranking.

The Hub filters are not a compatibility guarantee. Repositories can contain several ambiguous exports, unsupported processing stages, or incomplete metadata.

## As big as necessary, as small as possible

For local development, start with the smallest model that meets the application's language, domain, and retrieval-quality needs. Smaller models download and start faster, use less memory, and block SQLite for less time. Move to a larger model only when measurements on representative data show that the smaller one is insufficient.

The current default and Bookshop sample use [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). It was selected only because, at the time of selection, it was the most-downloaded reasonably small candidate matching the sentence-similarity, ONNX, and Apache-2.0 filters. This is not a recommendation for any application or for production, and the default may change at any time while local embeddings remain experimental. Configure the model explicitly when that choice must stay stable.

Ideally, identical embedding-models should be employed during development and in production. However, this is not technically required and hard to realize, due to model availability: I.e. local ONNX models and SAP HANA native models will differ. For reference, SAP HANA Cloud's [`SAP_GXY.20250407` is based on RoBERTa base](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/vector-embedding-function-vector#available-models-without-remote-source). A local MiniLM vector has different dimensions and semantics and is not interchangeable with a HANA-generated vector. Never mix vectors from different model setups; regenerate embeddings after a change.

## Check before installing

```sh
npx @cap-js/ai check-model owner/model
npx @cap-js/ai install-model owner/model
```

`check-model` examines repository metadata and reports likely compatibility without downloading the model weights. `install-model` performs the definitive check by downloading, loading, and probing the selected ONNX graph.

## Supported model contract

Discovery currently requires:

- a public Hugging Face repository whose declared task is absent, `sentence-similarity`, or `feature-extraction`
- an immutable repository revision
- an unambiguously selectable ONNX graph, preferring `onnx/model.onnx` and then `model.onnx`
- `tokenizer.json`, `tokenizer_config.json`, and `config.json` beside the graph or at repository root
- an embedding dimension in a common Transformers field such as `hidden_size`, `n_embd`, `d_model`, or `dim`
- a determinable input limit
- an unambiguous Sentence Transformers pipeline of Transformer, Pooling, and optional Normalize stages
- mean or CLS pooling
- when a model declares [prompts it was trained with](https://sbert.net/examples/sentence_transformer/training/prompts/README.html) (typically `query` and `document`): Metadata that maps these prompts to [SAP HANA `VECTOR_EMBEDDING`s `text-type`](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-sql-reference-guide/vector-embedding-function-vector)

The ONNX graph must accept rank-2 `int64` `input_ids`; it may also accept `attention_mask` and `token_type_ids`. A token-level output used for pooling must be a floating-point rank-3 tensor whose final dimension matches the discovered model dimension.

Nested exports are supported when the model and its companion files are unambiguous. Conventional adjacent external-data names are supported. Other module chains, ambiguous pooling, decoder outputs, incompatible task tags, missing metadata, or arbitrary external-data paths are rejected instead of guessed.
