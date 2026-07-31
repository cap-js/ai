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

  // Register VECTOR_EMBEDDING function
  // better-sqlite3 does NOT support arity-based dispatch - the second registration
  // overwrites the first. We register a variadic function that handles both 3 and 4 parameters.
  // Note: remote_source (4th param) is accepted for HANA API compatibility but ignored.
  // SQLite always uses the local ONNX model and cannot connect to remote embedding services.
  dbc.function(
    'VECTOR_EMBEDDING',
    { deterministic: true, varargs: true },
    (text, text_type, model_and_version, remote_source) => {
      return generateVector(text, text_type, model_and_version, embedding);
    }
  );
}

const model_dimensions = {
  'SAP_GXY.20250407': 384,
  'SAP_GXY.20240715': 384
};

function generateVector(text, _, model_and_version, embedding) {
  if (text) {
    return JSON.stringify(Array.from(embedding.embedding(text).embedding));
  }
  return JSON.stringify(new Array(model_dimensions[model_and_version] ?? 384).fill(0));
}
