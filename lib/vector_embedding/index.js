import cds from '@sap/cds';

const LOG = cds.log('@cap-js/ai');

let embeddingModule;
let initialization;

async function initializeEmbedding() {
  if (embeddingModule) return embeddingModule;

  initialization ??= import('./embedding.js')
    .then(async (module) => {
      await module.createSession();
      LOG.info('Vector embedding ONNX model initialized');
      return (embeddingModule = module);
    })
    .catch((error) => {
      initialization = undefined;
      throw error;
    });

  return initialization;
}

const model_dimensions = {
  'SAP_GXY.20250407': 384,
  'SAP_GXY.20240715': 384
};

/**
 * Synchronous wrapper for vector embedding function.
 * Generates embeddings using ONNX model.
 * The model is initialized automatically when this module is imported.
 *
 * @param {string} text - Text to embed
 * @param {string} text_type - Type of text (e.g., 'DOCUMENT')
 * @param {string} model_and_version - Model identifier (e.g., 'SAP_GXY.20250407')
 * @returns {string} JSON stringified array of embedding values
 * @throws {Error} If embedding module failed to initialize or generation fails
 */
function vector_embedding(text, text_type, model_and_version) {
  if (!embeddingModule) {
    throw new Error('Embedding module is not initialized');
  }

  if (text) {
    return JSON.stringify(Array.from(embeddingModule.embedding(text).embedding));
  }
  return JSON.stringify(new Array(model_dimensions[model_and_version] ?? 384).fill(0));
}

export { initializeEmbedding, vector_embedding };
