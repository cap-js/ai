const MIN_ONNX_RUNTIME_VERSION = '1.20.1';

function loadOnnxRuntime(requireModule) {
  try {
    const bindingModule = requireModule('onnxruntime-node/dist/binding.js');
    return {
      ort: requireModule('onnxruntime-node'),
      binding: bindingModule.binding,
      initOrt: bindingModule.initOrt
    };
  } catch (error) {
    if (
      (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') &&
      /['"]onnxruntime-node(?:\/[^'"]*)?['"]/.test(error.message)
    ) {
      throw new Error(
        `Using local SQLite embeddings requires onnxruntime-node@^${MIN_ONNX_RUNTIME_VERSION}. Install it with 'npm add -D onnxruntime-node@^${MIN_ONNX_RUNTIME_VERSION}'.`,
        { cause: error }
      );
    }
    throw error;
  }
}

export { MIN_ONNX_RUNTIME_VERSION, loadOnnxRuntime };
