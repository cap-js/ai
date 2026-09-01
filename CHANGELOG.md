# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 1.2.0 - tbd

### Added

- **Experimental:** Extend the standard `sqlite` service and its `sqlite:memory` preset for local CAP development with `VECTOR_EMBEDDING`, model provisioning tooling, and `sentence-transformers/all-MiniLM-L6-v2` as a replaceable default that may change while the feature remains experimental.
- **Experimental:** Add local `SPARQL_EXECUTE` and `sparql_table` support through the optional `oxigraph` peer dependency.

Local vector embeddings require `@sap/cds` `^10.1` and `@cap-js/sqlite` `^3.1`; the package's other capabilities continue to support `@sap/cds` 9.

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
