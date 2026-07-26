# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).


## Unreleased

### Added
- New `cds.requires.AICore.recommendations` config flag: `"auto"` (default, current behavior) or `"opt-in"`, where only fields with an explicit truthy `@UI.RecommendationState` are enrolled for recommendations — for controlled, incremental rollouts on large existing models

### Fixed
- Association/composition elements (e.g. the draft-added `DraftAdministrativeData`) are no longer sent to RPT-1 `/predict`, fixing HTTP 422 errors (and silently empty recommendations) on draft reads whenever other edit drafts of the entity exist

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
