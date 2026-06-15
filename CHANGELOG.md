# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 1.1.0

### Added
- Local inference mode using the open-source [SAP RPT-1 OSS](https://huggingface.co/SAP/sap-rpt-1-oss) model (`AICore-local`), without requiring an SAP AI Core service binding
- HuggingFace Inference API mode (`AICore-hf`) as a lightweight alternative that requires only a HuggingFace token
- Automatic model download on first startup; checkpoint and sentence embedder are cached in `~/.cache/sap-rpt-1-oss/`
- Configure HuggingFace token via `cds.rpt.hfToken` in `.cdsrc-private.json`

## Version 1.0.1 - 2026-05-08

### Fixed
- Empty recommendations on read on active entities are returned empty to avoid UI errors

## Version 1.0.0 - 2026-04-28

### Added
- Out of box support for recommended values in field helps in Fiori UIs by providing an `SAP_Recommendations` navigation property in OData services which contains the recommendations.
- Provide a CAP `AICore` service, via which SAP AI Core artefacts can be queried, like 'resourceGroups', 'deployments' or 'configurations' with `cds.ql` (`SELECT.from(resourceGroups)` and alike).
- Automatically create an AI Core deployment for SAP RPT-1 which is used for the recommended values in single tenant and multi tenant scenarios. 
- Automatically creates an AI Core resource group per tenant in multi tenant scenarios. In single tenant mode the 'default' resource group is used.
