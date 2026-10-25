import { installModel as install } from './vector_embedding/model-install.js';

/** Install and validate an embedding model without registering CAP plugin hooks. */
export async function installModel(repository, options = {}) {
  const validate =
    options.validate ?? (await import('./vector_embedding/embedding.js')).validateEmbeddingModel;
  return install(repository, { ...options, validate });
}
