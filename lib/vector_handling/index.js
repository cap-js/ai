import cds from '@sap/cds';

const LOG = cds.log('@cap-js/ai');

export default async function addSQLiteVectorSupport(dbc) {
  let embedding;
  try {
    embedding = await import('./semantic-search/embedding.js');
  } catch (err) {
    LOG.warn('Failed to load embedding module:', err.message);
    return;
  }

  try {
    await embedding.createSession();
  } catch (err) {
    LOG.warn('Failed to initialize embedding model:', err.message);
    return;
  }

  // Register VECTOR_EMBEDDING with 3 parameters (text, text_type, model_and_version)
  dbc.function('VECTOR_EMBEDDING', { deterministic: true }, (text, text_type, model_and_version) => {
    if (text_type !== 'DOCUMENT' && text_type !== 'QUERY')
      throw Error(`VECTOR_EMBEDDING called but text_type is ${text_type} and not DOCUMENT or QUERY`);
    return generateVector(text, text_type, model_and_version, embedding);
  });

  // Register VECTOR_EMBEDDING with 4 parameters (including remote_source)
  dbc.function('VECTOR_EMBEDDING', { deterministic: true }, (text, text_type, model_and_version, remote_source) => {
    if (text_type !== 'DOCUMENT' && text_type !== 'QUERY')
      throw Error(
        `VECTOR_EMBEDDING called for ${remote_source} but text_type is ${text_type} and not DOCUMENT or QUERY`
      );
    return generateVector(text, text_type, model_and_version, embedding);
  });
}

const model_dimensions = {
  'SAP_GXY.20250407': 384,
  'SAP_GXY.20240715': 384,
};

function generateVector(text, _, model_and_version, embedding) {
  if (text) {
    return JSON.stringify(Array.from(embedding.embedding(text).embedding));
  }
  return JSON.stringify(new Array(model_dimensions[model_and_version] ?? 384).fill(0));
}
