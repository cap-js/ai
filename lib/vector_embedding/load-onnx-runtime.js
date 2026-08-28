const SUPPORTED_ONNX_RUNTIME_VERSION = '1.20.1';

function loadOnnxRuntime(requireModule) {
  try {
    const runtimeVersion = requireModule('onnxruntime-node/package.json').version;
    if (runtimeVersion !== SUPPORTED_ONNX_RUNTIME_VERSION) {
      throw new Error(
        `Unsupported onnxruntime-node version ${runtimeVersion}; @cap-js/ai requires ${SUPPORTED_ONNX_RUNTIME_VERSION} because its synchronous SQLite integration uses the runtime's private native API.`
      );
    }
    return {
      ort: requireModule('onnxruntime-node'),
      binding: requireModule('onnxruntime-node/dist/binding.js').binding
    };
  } catch (error) {
    if (
      (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') &&
      /['"]onnxruntime-node(?:\/[^'"]*)?['"]/.test(error.message)
    ) {
      throw new Error(
        "Using ai-sqlite embeddings requires onnxruntime-node@1.20.1. Install it with 'npm add -D onnxruntime-node@1.20.1'.",
        { cause: error }
      );
    }
    throw error;
  }
}

export { SUPPORTED_ONNX_RUNTIME_VERSION, loadOnnxRuntime };
