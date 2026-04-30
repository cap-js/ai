# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 1.1.0 - Upcoming

### Added

- New `@UI.RecommendationState` opt-in annotation for scalar fields without a value help (free-form numerics, free-text). Annotated fields are added to the entity's `<Entity>_Recommendations` companion alongside value-helped fields. RPT-1 `task_type` is selected per column: numeric scalars opted in via `@UI.RecommendationState` use `regression` so the model can interpolate continuous values; everything else uses `classification` (existing behaviour). The `task_type` enum on `predictRowColumns` is widened from `{classification}` to `{classification, regression}`.

### Fixed
- CDS-to-RPT-1 dtype map now matches the inference API's enum (`'string' | 'numeric' | 'date'`). Previously emitted `'bool'` for `cds.Boolean` and `'datetime'` for `cds.DateTime` / `cds.Timestamp`, causing HTTP 422 from `/predict` for any entity carrying those types. `cds.DateTime` and `cds.Timestamp` now map to `'string'` so the full ISO value is preserved as an opaque token (no time loss, no date-parse rejection).
- Composition children of draft-enabled entities are now reliably enhanced. The CSN enhancer previously only walked `entity.compositions` — a legacy CSN shape — and missed the `entity.elements[*]` form used by current CDS, with the result that nested entities (e.g. `Approvers` under a `ChangeRequests` draft) never received `@UI.Recommendations` and so never got recommendations even when their fields had value lists. The walk is now recursive through both shapes with cycle protection.
- Empty-rows crash in `_fetchPrediction`. Reading a draft entity whose composition was empty fed `rows: []` to the prediction API, and the schema-derivation reduce dereferenced `rows[0][ele]` on `undefined`, taking the whole server down on a TypeError. `_fetchPrediction` now returns an empty result for empty input. The READ handler also short-circuits when the response set is empty, avoiding a needless AI Core round-trip.
- RPT-1 inference limits now honoured. When `target_columns.length > 10` or when a row carries more than 100 columns, `_fetchPrediction` logs a warning and returns an empty result instead of letting the API reject the request with a noisy 422. The warning includes a hint to use `@UI.RecommendationState : 0` to opt fields out and bring the count down.

## Version 1.0.0 - 28.04.2026

### Added
- Out of box support for recommended values in field helps in Fiori UIs by providing an `SAP_Recommendations` navigation property in OData services which contains the recommendations.
- Provide a CAP `AICore` service, via which SAP AI Core artefacts can be queried, like 'resourceGroups', 'deployments' or 'configurations' with `cds.ql` (`SELECT.from(resourceGroups)` and alike).
- Automatically create an AI Core deployment for SAP RPT-1 which is used for the recommended values in single tenant and multi tenant scenarios. 
- Automatically creates an AI Core resource group per tenant in multi tenant scenarios. In single tenant mode the 'default' resource group is used.
