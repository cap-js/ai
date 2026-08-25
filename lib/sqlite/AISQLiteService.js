import SQLiteService from '@cap-js/sqlite';
import { initializeEmbedding, vector_embedding } from '../vector_embedding/index.js';

export default class AISQLiteService extends SQLiteService {
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
      return dbc;
    };
    return factory;
  }

  static CQN2SQL = class CQN2AISQLite extends SQLiteService.CQN2SQL {
    // add cqn2sql stuff here
    static Functions = {
      ...SQLiteService.CQN2SQL.Functions
    };
  };
}
