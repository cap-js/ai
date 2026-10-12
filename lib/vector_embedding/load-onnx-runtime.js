const MIN_ONNX_RUNTIME_VERSION = '1.20.1';

function _versionInRange(version) {
  const nums = (v) => v.split('-')[0].split('.').map(Number);
  const [maj, min, pat] = nums(version);
  const [minMaj, minMin, minPat] = nums(MIN_ONNX_RUNTIME_VERSION);
  if (maj !== minMaj) return false;
  if (min !== minMin) return min > minMin;
  return pat >= minPat;
}

function loadOnnxRuntime(requireModule) {
  try {
    const runtimeVersion = requireModule('onnxruntime-node/package.json').version;
    if (!_versionInRange(runtimeVersion)) {
      throw new Error(
        `Unsupported onnxruntime-node version ${runtimeVersion}; @cap-js/ai requires ^${MIN_ONNX_RUNTIME_VERSION} because its synchronous SQLite integration uses the runtime's private native API.`
      );
    }
    const bindingModule = requireModule('onnxruntime-node/dist/binding.js');
    return {
      ort: requireModule('onnxruntime-node'),
      binding: bindingModule.binding,
      initOrt: bindingModule.initOrt // present in >=1.21.0; undefined in 1.20.x
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
