import cds from '@sap/cds';
import SQLiteService from '@cap-js/sqlite';
import { createEmbeddingRuntime } from '../vector_embedding/embedding.js';
import TripleStore from '../knowledge-graph/triplestore.js';

const LOG = cds.log('@cap-js/ai');
const $tripleStore = Symbol('tripleStore');

export default class AISQLiteService extends SQLiteService {
  _tripleStores = new Map();

  async init() {
    this._embeddingRuntime = await createEmbeddingRuntime(this.options.embedding);
    LOG.info('Vector embedding ONNX model initialized');
    return super.init();
  }

  get factory() {
    const factory = super.factory;
    const create = factory.create;
    factory.create = async (tenant) => {
      const dbc = await create(tenant);
      const embedding = (input, textType, modelAndVersion) =>
        input == null
          ? null
          : this._embeddingRuntime.vectorEmbedding(String(input), textType, modelAndVersion);
      const deterministic = { deterministic: true };
      dbc.function('VECTOR_EMBEDDING', { ...deterministic, varargs: true }, embedding);
      dbc.function('VECTOR_EMBEDDING', deterministic, embedding);

      const key = tenant ?? '';
      const store = this._tripleStores.get(key) ?? new TripleStore();
      this._tripleStores.set(key, store);
      dbc[$tripleStore] = store;
      dbc.function('sparql_table', (query) => store.query(query).RESPONSE);
      return dbc;
    };
    return factory;
  }

  async disconnect(tenant) {
    await super.disconnect(tenant);
    if (tenant == null) this._tripleStores.clear();
    else this._tripleStores.delete(tenant);
  }

  onPlainSQL(req, next) {
    const { query } = req;
    if (!/^\s*CALL\s+SPARQL_EXECUTE\b/i.test(query)) return super.onPlainSQL(req, next);

    const match =
      /^\s*CALL\s+SPARQL_EXECUTE\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*\?\s*,\s*\?\s*\)\s*;?\s*$/i.exec(
        query
      );
    if (!match) throw new Error(`Unsupported SPARQL_EXECUTE syntax: ${query}`);

    const store = this.dbc?.[$tripleStore];
    if (!store) throw new Error('SPARQL_EXECUTE requires an active database connection');
    const unescape = (value) => value.replace(/''/g, "'");
    return store.execute(unescape(match[1]), unescape(match[2]));
  }

  static CQN2SQL = class CQN2AISQLite extends SQLiteService.CQN2SQL {
    static Functions = {
      ...SQLiteService.CQN2SQL.Functions,
      sparql_table(query) {
        if (typeof query.val !== 'string') {
          throw new Error('sparql_table expects a literal SPARQL SELECT query');
        }

        // Keep the SQL projection deliberately narrow, but accept the SPARQL
        // prologue and the optional WHERE keyword (both are valid SPARQL).
        const iri = '<(?:[^>\\\\]|\\\\.)*>';
        const prologue = `(?:(?:BASE\\s+${iri}|PREFIX\\s+(?:[A-Za-z][A-Za-z0-9._-]*)?:\\s*${iri})\\s*)*`;
        const match = new RegExp(
          `^\\s*${prologue}SELECT\\s+(?:(?:DISTINCT|REDUCED)\\s+)?((?:[?$][A-Za-z_][A-Za-z0-9_]*\\s*)+)(?:WHERE\\s*)?\\{`,
          'is'
        ).exec(query.val);
        if (!match) {
          throw new Error('sparql_table only supports explicitly projected SPARQL variables');
        }

        const projection = match[1];
        const variables = projection.match(/[?$][A-Za-z_][A-Za-z0-9_]*/g);

        const columns = variables.map((variable) => variable.slice(1));
        const select = columns.map(
          (column) => `value->>'$.${column}.value' as ${this.quote(column)}`
        );
        return `(SELECT ${select} FROM json_each(sparql_table(${query})->'$.results.bindings'))`;
      }
    };
  };
}
