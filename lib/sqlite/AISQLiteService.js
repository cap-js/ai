import cds from '@sap/cds';
import SQLiteService from '@cap-js/sqlite';
import { createEmbeddingRuntime } from '../vector_embedding/embedding.js';

const LOG = cds.log('@cap-js/ai');

export default class AISQLiteService extends SQLiteService {
  async init() {
    this._embeddingRuntime = await createEmbeddingRuntime(this.options.embedding, {
      root: cds.root,
      warn: (message) => LOG.warn(message)
    });
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
