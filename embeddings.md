## Simplified embeddings

For natural language processing it is crucial to embed text data into a Vector. HANA Cloud offers a `VECTOR_EMBEDDING` function via which an embedding can be generated. The model which can be specified can either be an SAP model, when [HANA Cloud NLP](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-nlp-51eb170d038d4099a9bbb85c08fda888?locale=en-US) is enabled or a [model provided in SAP AI Core](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-sap-ai-core?locale=en-US), like the ones from OpenAI or AWS.

> [!HINT]
> cds.Vector support and standardized vector functions on other databases is work in progress. You can use the `cap-js-sqlite-2.2.0.tgz` file as part of this plugin to already try out the sqlite support. HANA Cloud functions like `vector_embedding`, `cosine_similarity`, `l2distance` or `cardinality` will work with this as well on SQLite.

Use `@ai.embedding` and `@ai.embedding.@ai.model` to easily generate a vector column and automatically fill it with embeddings. The default model used is 'SAP_GXY.20250407' but can be overridden via `cds.env.ai.embeddings.defaultModel`.

```cds
entity Books {
  key ID : Integer;
  title  : String(111);
  @ai.embedding
  descr  : String(1111);
}
```

```cds
entity Books {
  key ID : Integer;
  title  : String(111);
  @ai.embedding
  @ai.embedding.@ai.model : 'amazon--titan-embed-text."1.2"'
  descr  : String(1111);
}
```

HANA Cloud has native models for text embedding when their Natural Language Processing feature is enabled: `SAP_GXY.20250407` and `SAP_NEB.20240715`. However HANA Cloud can also be connected to AI Core via a remote source, and then embedding models from OpenAI and AWS can be used as well.

Because the remote source needs to be referenced within the `VECTOR_EMBEDDING` function, but the syntax is invalid within CAP, the plugin automatically adds the configured remote source, when the model is not from SAP. The default remote source is `AI_CORE` but it can be overridden via `cds.env.ai.embeddings.remoteSource`.

Behind the scenes the annotations will generate a column similar to this:

```cds
entity Books {
  key ID : Integer;
  title  : String(111);
  descr  : String(1111);
  embedding : Vector = (VECTOR_EMBEDDING(descr, 'DOCUMENT', 'amazon--titan-embed-text."1.2"')) stored;
}
```

> [!INFO]
> The fourth parameter is the remote source in HANA Cloud which is mandatory for models provided by SAP AI Core. The plugin will automatically fill it with the default remote source `cds.env.ai.embeddings.remoteSource` if the parameter is not provided.

### Using non SAP models for embeddings with SAP HANA Cloud

Currently the setup is not ideal when models provided by SAP AI Core shall be used. You have to complete the following steps to get it to work:

1. Follow the [Creating Text Embeddings with SAP AI Core](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide/creating-text-embeddings-with-sap-ai-core?locale=en-US) documentation in SAP Help.
2. After creating the PSE and the remote source in HANA Cloud, you need to grant the privileges for referencing the remote source to a user, which in turn can grant it to the HDI user for your CAP application. The following SQL creates a user group which can send requests to the remote source, creates a user and grants the user permissions to grant other users permissions to send requests to the remote source.

   ```sql
   CREATE ROLEGROUP HDI_GRANTOR_GROUP;

   CREATE ROLE HC_REMOTESOURCE_GRANTOR SET ROLEGROUP HDI_GRANTOR_GROUP;

   GRANT EXECUTE ON REMOTE SOURCE <REMOTE_SOURCE_NAME> TO HC_REMOTESOURCE_GRANTOR WITH GRANT OPTION;

   -- Choose a unique password
   ALTER USER HDI_GRANT_USER PASSWORD <password_for_user> NO FORCE_FIRST_PASSWORD_CHANGE;
   GRANT HC_REMOTESOURCE_GRANTOR TO HDI_GRANT_USER WITH GRANT OPTION;
   ```

3. Create a user provided service on BTP with the credentials for the user:

   ```ssh
   cf cups hana_ai -p '{"username":"HDI_GRANT_USER","password":"<password_for_user>", "tags": ["hana"]}'
   ```

4. Create an `.hdbgrants` file in `db/src`. HDI will pick this up during deployment and use the permissions of the user to grant its permissions to the HDI users.

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

> [!WARNING]
> In Multi-Tenancy scenarios you would have to create a remote source per tenant and assign the reference privilege to the respective tenant binding. The remote source per tenant should be done because in AI Core each tenant should have a different resource group for isolation.

### Similarity search

When a property is annotated with `@ai.embedding`, searching on the entity will no longer do a regular string based search, but instead use a cosine similarity search leveraging the embedding for that property.

The fuzziness threshold will be used as the threshold for similarity as well. You can change the threshold via `@Search.fuzzinessThreshold`.

```cds
entity Books {
    key ID : Integer;
    @ai.embedding
    @Search.fuzzinessThreshold: 0.5
    description                  : String(1111);
}
```
