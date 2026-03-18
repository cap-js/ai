# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 1.0.0-alpha.1 - TBD

### Added
- Out of box support for recommended values in field helps in Fiori UIs by providing an `SAP_Recommendations` navigation property in OData services which contains the recommendations.
- Provide a CAP `AICore` service, via which SAP AI Core artefacts can be queried, like 'resourceGroups', 'deployments' or 'configurations' with `cds.ql` (`SELECT.from(resourceGroups)` and alike).
- Automatically create an AI Core deployment for SAP RPT-1 which is used for the recommended values in single tenant and multi tenant scenarios. 
- Automatically creates an AI Core resource group per tenant in multi tenant scenarios. In single tenant mode the 'default' resource group is used.
- Annotate string properties with `@ai.embedding` to create an embedding for the field. Embedding fields are automatically used during search queries to leverage similarity search instead of regular search.
    - Define the AI model via `@ai.embedding.@ai.model`. The models available in HANA Cloud can be used.
    - For SQLite support a custom `@cap-js/sqlite` version needs to be used as `cds.Vector` support on SQLite is not yet natively available. With that most HANA Cloud functions for interacting with vectors are available on SQLite.
