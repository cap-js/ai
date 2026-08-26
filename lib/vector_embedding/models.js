const DEFAULT_MODEL = Object.freeze({
  repository: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dimensions: 384,
  maxLength: 128,
  files: Object.freeze([
    Object.freeze({
      role: 'model',
      name: 'model.onnx',
      path: 'onnx/model.onnx',
      size: 90387606,
      sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e'
    }),
    Object.freeze({
      role: 'tokenizer',
      name: 'tokenizer.json',
      path: 'tokenizer.json',
      size: 711661,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
    }),
    Object.freeze({
      role: 'tokenizerConfig',
      name: 'tokenizer_config.json',
      path: 'tokenizer_config.json',
      size: 366,
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
    })
  ]),
  output: Object.freeze({
    name: 'last_hidden_state',
    pooling: 'mean',
    normalize: true
  })
});

const MODEL_PRESETS = new Map([[DEFAULT_MODEL.repository, DEFAULT_MODEL]]);

function findModelPreset(name) {
  return MODEL_PRESETS.get(name);
}

function resolveModelPreset(name) {
  const model = findModelPreset(name);
  if (!model) {
    throw new Error(
      `Unsupported embedding model '${name}'. Use --descriptor for a compatible custom model.`
    );
  }
  return model;
}

export { DEFAULT_MODEL, findModelPreset, resolveModelPreset };
