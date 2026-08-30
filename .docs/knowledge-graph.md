# Local knowledge graph

> [!WARNING]
> The local knowledge graph is experimental and intended only for local development. Its API and storage model may change incompatibly.

Install the optional peer dependency:

```sh
npm add -D oxigraph
```

Both `ai-sqlite` and `ai-sqlite:memory` expose a process-local Oxigraph store through `SPARQL_EXECUTE` and `sparql_table`.

## Load RDF

Use the HANA-compatible procedure shape:

```sql
CALL SPARQL_EXECUTE(
  'LOAD <db/data/catalog.ttl> INTO GRAPH <https://example.test/catalog>',
  '',
  ?,
  ?
)
```

The final two `?` tokens are required output placeholders, not input bindings. The local implementation accepts literal SPARQL and header strings only. `LOAD` returns no result.

Files must be inside the CAP project. Turtle and compressed Turtle inputs are supported; unsafe paths, symlinks escaping the project, malformed RDF, and unsupported formats are rejected.

## Query RDF

Procedure-style queries return a serialized result in `RESPONSE`:

```sql
CALL SPARQL_EXECUTE(
  'SELECT ?subject WHERE { ?subject ?predicate ?object }',
  'accept:application/sparql-results+json',
  ?,
  ?
)
```

Use `sparql_table` from CQN when rows should be projected into a query result:

```js
await db.run({
  SELECT: {
    from: cds.ql.func(
      'sparql_table',
      'SELECT ?subject ?predicate WHERE { ?subject ?predicate ?object }'
    )
  }
});
```

The RDF store lives in memory and is tied to the database service connection. Its contents are lost on disconnect or process restart even with file-based `ai-sqlite`, and RDF updates are not transactionally coupled to SQLite changes.
