import cds from '@sap/cds';
import * as embeddingModule from './embedding.js';

const LOG = cds.log('@cap-js/ai');
let loggedInitialization = false;
let dimensions;

async function initializeEmbedding(configuration, options) {
  const runtime = await embeddingModule.createSession(configuration, options);
  dimensions = runtime.dimensions;
  if (!loggedInitialization) {
    LOG.info('Vector embedding ONNX model initialized');
    loggedInitialization = true;
  }
  return embeddingModule;
}

function vector_embedding(text, text_type, model_and_version) {
  void text_type; // Retained for HANA-compatible function arity.
  void model_and_version; // The configured embedding model determines vector dimensions.
  if (text) return JSON.stringify(Array.from(embeddingModule.embedding(text).embedding));
  if (!dimensions) {
    throw new Error(
      'Embedding session not initialized. Call initializeEmbedding() with an embedding configuration before using vector_embedding().'
    );
  }
  return JSON.stringify(new Array(dimensions).fill(0));
}

export { initializeEmbedding, vector_embedding };
