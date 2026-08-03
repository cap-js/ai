import cds from '@sap/cds';

const LOG = cds.log('@cap-js/ai');

// Auto-initialize on module load
let embeddingModule;
let initializationError;

try {
  embeddingModule = await import('./embedding.js');
  await embeddingModule.createSession();
  LOG?.info?.('Vector embedding ONNX model initialized');
} catch (err) {
  LOG.warn('Failed to initialize embedding model:', err.message);
  initializationError = err;
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
  if (initializationError) {
    throw new Error(
      `Embedding module failed to initialize: ${initializationError.message}`
    );
  }

  if (!embeddingModule) {
    throw new Error('Embedding module not available');
  }

  if (text) {
    return JSON.stringify(Array.from(embeddingModule.embedding(text).embedding));
  }
  return JSON.stringify(new Array(model_dimensions[model_and_version] ?? 384).fill(0));
}

export { vector_embedding };
