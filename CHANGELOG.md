# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 1.2.0 - tbd

### Added

- **Beta:** Add the `ai-sqlite` and `ai-sqlite:memory` kinds with a `VECTOR_EMBEDDING` function using compatible ONNX encoder models
  - Uses a file-based database for `ai-sqlite` and an in-memory database for `ai-sqlite:memory`
  - Requires `cds.env.requires.db.embedding.model`; automatically discovers model metadata and supports warned, on-demand provisioning into `.cds/models`
  - Adds `npx @cap-js/ai install-model <model>` with an optional shared model-cache root
  - Uses the optional `@huggingface/tokenizers` peer dependency and truncates long input to the first model input window
  - Configures embedding runtimes only through `model` and an optional relative, absolute, or home-relative `directory`; discovered metadata remains in the provisioned lock
  - Supports both 3-parameter `(text, text_type, model_and_version)` and 4-parameter variants with `remote_source`
  - Compatible with `SAP_GXY.20250407` and `SAP_GXY.20240715` model versions
  - Synchronous execution suitable for SQLite user-defined functions
  - Embeds one model input window; applications split long documents and store one vector per chunk
- Experimental!: Add local `SPARQL_EXECUTE` and `sparql_table` support to both AI-enabled SQLite kinds through the optional `oxigraph` peer dependency

## Version 1.1.0 - 2026-07-20

### Added
- New `@UI.RecommendationState` opt-in annotation for scalar fields to use Regression prediction from RPT-1

### Changed
- Extend `task_type` to `{classification, regression}`

### Fixed
- Row-level authorization is now enforced when collecting the recommendations context
- CDS-to-RPT-1 dtype map now correctly maps `cds.Boolean` to `'string'` and `cds.DateTime`/`cds.Timestamp` to `'string'`, fixing HTTP 422 errors from `/predict`
- Recurisly enhance composition children of draft-enabled entities so recommendations are displayed for nested entities
- Fix empty-rows server crash in `_fetchPrediction` when draft entity compositions are empty, now returns an empty result instead of throwing a TypeError
- RPT-1 inference limits now honoured: `_fetchPrediction` logs a warning and returns empty when `target_columns > 10` or `row columns > 100`, instead of letting the API reject with a 422

## Version 1.0.1 - 2026-05-08

### Fixed
- Empty recommendations on read on active entities are returned empty to avoid UI errors

## Version 1.0.0 - 2026-04-28

### Added
- Out of box support for recommended values in field helps in Fiori UIs by providing an `SAP_Recommendations` navigation property in OData services which contains the recommendations.
- Provide a CAP `AICore` service, via which SAP AI Core artefacts can be queried, like 'resourceGroups', 'deployments' or 'configurations' with `cds.ql` (`SELECT.from(resourceGroups)` and alike).
- Automatically create an AI Core deployment for SAP RPT-1 which is used for the recommended values in single tenant and multi tenant scenarios. 
- Automatically creates an AI Core resource group per tenant in multi tenant scenarios. In single tenant mode the 'default' resource group is used.
