# Recommendations

`@cap-js/ai` uses [SAP-RPT-1](https://help.sap.com/docs/sap-ai-core/generative-ai/sap-rpt-1) through SAP AI Core to add recommendations to CAP draft entities.

## Selecting fields

Fields with `@Common.ValueList` or associations whose targets have `@cds.odata.valuelist` are included automatically. Disable recommendations for an individual field with `@UI.RecommendationState: 0`; dynamic expressions are supported as well.

```cds
annotate Books with {
  genre @UI.RecommendationState: (price > 200 ? 0 : 1);
}
```

Scalar fields without a value help can opt in with `@UI.RecommendationState`:

```cds
entity CalibrationData : cuid {
  measuringRangeMin : Decimal(16, 6) @UI.RecommendationState;
  measuringRangeMax : Decimal(16, 6) @UI.RecommendationState;
  description       : String         @UI.RecommendationState;
}
```

Numeric scalar fields without value helps use the `regression` task type. Other fields use `classification`. A numeric field with a value help remains a classification target.

> [!NOTE]
> SAP Fiori Elements does not yet render recommendations for scalar fields without a value help. The backend provides them, but the client currently requests and displays recommendation fields only when they have `@Common.ValueList` or `@Common.ValueListWithFixedValues`.

## Generated service shape

For each draft-enabled entity with recommendable fields, the plugin adds:

- `@UI.Recommendations: { '=': 'SAP_Recommendations' }`
- a virtual `<Entity>_Recommendations` companion entity
- one recommendation array per included field

Each recommendation contains `RecommendedFieldValue`, `RecommendedFieldDescription`, `RecommendedFieldScoreValue`, and `RecommendedFieldIsSuggestion`. Fiori Elements uses the first suggestion as the soft-fill default.

Recommendations are calculated when a draft-entity `READ` expands `SAP_Recommendations`. Active-entity reads return no recommendations, and reads during `draftActivate` are skipped.

## Prediction context and data handling

The plugin sends up to 2,000 active rows of the same entity to SAP-RPT-1. Only rows for which every recommendation target is non-null are included. The active version of the current draft is replaced by the draft row containing `[PREDICT]` placeholders.

The following elements are removed from the context:

- `createdAt`, `createdBy`, `modifiedAt`, and `modifiedBy`
- `cds.LargeBinary` and `cds.Vector` elements
- fields excluded by `@UI.RecommendationState: 0` or a matching dynamic expression

> [!IMPORTANT]
> All other selected columns are forwarded to SAP AI Core. Review the entity model and exclude sensitive fields explicitly.

There is no sampling or `ORDER BY`; for entities with more than 2,000 qualifying rows, the database determines which rows are used. If `@Common.Text` is configured, the plugin performs an additional lookup to populate the recommendation description.

## SAP-RPT-1 lifecycle

The first prediction for a resource group creates an `sap-rpt-1-small` deployment in scenario `foundation-models` when none exists. The plugin waits for the deployment to reach `RUNNING` and reuses it afterward.

Single-tenant applications use the configured `AICore.resourceGroup`, which defaults to `default`. Multitenant applications create a resource group per tenant during subscription and delete it during unsubscription.

## Local development

Without an SAP AI Core binding, the plugin uses `MockAICoreService`. It returns the first non-null value for each target column. This is useful for UI smoke tests but is not a quality signal.

To use a real deployment locally, bind the application and start it with the `hybrid` profile:

```sh
cds bind <your-aicore-instance>
cds watch --profile hybrid
```
