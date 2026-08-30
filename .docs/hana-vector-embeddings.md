# SAP HANA vector embeddings

SAP HANA Cloud provides `VECTOR_EMBEDDING` for generating embeddings with native models or models exposed through an SAP AI Core remote source.

## Native models

Add a calculated vector element to a CDS entity:

```cds
entity Books {
  key ID    : Integer;
      title : String(111);
      descr : String(1111);

      @cds.api.ignore
      embedding : Vector = (VECTOR_EMBEDDING(descr, 'DOCUMENT', 'SAP_GXY.20250407')) stored;
}
```

See the SAP HANA Cloud documentation for the [available models and their characteristics](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/vector-embedding-function-vector#available-models-without-remote-source).

## Models through SAP AI Core

SAP HANA Cloud can also call embedding models exposed through an SAP AI Core remote source. Follow the [SAP HANA Cloud setup guide](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-sap-ai-core?locale=en-US) first.

The fourth `VECTOR_EMBEDDING` parameter names the remote source. When it is omitted for an SAP AI Core model, the plugin uses `cds.env.ai.embeddings.remoteSource`, whose default is `AI_CORE`.

The HDI container needs permission to reference the remote source. One setup is to create a grantor role and user:

```sql
CREATE ROLEGROUP HDI_GRANTOR_GROUP;
CREATE ROLE HC_REMOTESOURCE_GRANTOR SET ROLEGROUP HDI_GRANTOR_GROUP;
GRANT EXECUTE ON REMOTE SOURCE <REMOTE_SOURCE_NAME>
  TO HC_REMOTESOURCE_GRANTOR WITH GRANT OPTION;

ALTER USER HDI_GRANT_USER PASSWORD <password> NO FORCE_FIRST_PASSWORD_CHANGE;
GRANT HC_REMOTESOURCE_GRANTOR TO HDI_GRANT_USER WITH GRANT OPTION;
```

Create a user-provided service containing those credentials:

```sh
cf cups hana_ai -p '{"username":"HDI_GRANT_USER","password":"<password>","tags":["hana"]}'
```

Then add an `.hdbgrants` file under `db/src`:

```json
{
  "hana_ai": {
    "object_owner": {
      "roles": ["HC_REMOTESOURCE_GRANTOR"]
    },
    "application_user": {
      "roles": ["HC_REMOTESOURCE_GRANTOR"]
    }
  }
}
```

If every HDI container may access the remote source, SAP HANA Cloud also supports granting the permission to the shared HDI deployment infrastructure role. Review the linked setup guide before choosing that broader grant.

In multitenant applications, create a remote source per tenant and grant access to the corresponding tenant binding so SAP AI Core resource groups remain isolated.
