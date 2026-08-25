import cds from '@sap/cds';
import * as embeddingModule from './embedding.js';

const LOG = cds.log('@cap-js/ai');
let loggedInitialization = false;
const { dimensions: DEFAULT_DIMENSIONS } = embeddingModule.DEFAULT_MODEL;
const modelDimensions = {
  'SAP_GXY.20250407': DEFAULT_DIMENSIONS,
  'SAP_GXY.20240715': DEFAULT_DIMENSIONS
};

async function initializeEmbedding() {
  await embeddingModule.createSession();
  if (!loggedInitialization) {
    LOG.info('Vector embedding ONNX model initialized');
    loggedInitialization = true;
  }
  return embeddingModule;
}

function vector_embedding(text, text_type, model_and_version) {
  void text_type; // Retained for HANA-compatible function arity.
  if (text) return JSON.stringify(Array.from(embeddingModule.embedding(text).embedding));
  return JSON.stringify(
    new Array(modelDimensions[model_and_version] ?? DEFAULT_DIMENSIONS).fill(0)
  );
}

export { initializeEmbedding, vector_embedding };
