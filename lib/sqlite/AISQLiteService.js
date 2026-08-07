import SQLiteService from '@cap-js/sqlite';
import { initializeEmbedding, vector_embedding } from '../vector_embedding/index.js';
import TripleStore from '../knowledge-graph/triplestore.js';

const $tripleStore = Symbol('tripleStore');

export default class AISQLiteService extends SQLiteService {
  _tripleStores = new Map();

  async init() {
    await initializeEmbedding();
    return super.init();
  }

  get factory() {
    const factory = super.factory;
    const create = factory.create;
    factory.create = async (tenant) => {
      const dbc = await create(tenant);
      const embedding = (input, textType, modelAndVersion) =>
        input == null ? null : vector_embedding(String(input), textType, modelAndVersion);
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

        const match = /^\s*SELECT\s+(?:DISTINCT\s+)?(.+?)\s+WHERE\b/is.exec(query.val);
        if (!match || match[1].trim() === '*') {
          throw new Error('sparql_table only supports explicitly projected SPARQL variables');
        }

        const projection = match[1];
        const variables = projection.match(/\?[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        if (!variables.length || projection.replace(/\?[A-Za-z_][A-Za-z0-9_]*/g, '').trim()) {
          throw new Error('sparql_table only supports simple SPARQL variable projections');
        }

        const columns = variables.map((variable) => variable.slice(1));
        const select = columns.map(
          (column) => `value->>'$.${column}.value' as ${this.quote(column)}`
        );
        return `(SELECT ${select} FROM json_each(sparql_table(${query})->'$.results.bindings'))`;
      }
    };
  };
}
