import fs from 'node:fs/promises';

const STANDARD_INPUT_NAMES = new Set(['input_ids', 'attention_mask', 'token_type_ids']);
const TENSOR_TYPES = new Map([
  [1, 'float32'],
  [7, 'int64'],
  [11, 'float64']
]);

async function inspectOnnxModelFile(modelPath) {
  let model;
  try {
    const { onnx } = await loadOnnxProto();
    model = onnx.ModelProto.decode(await fs.readFile(modelPath));
  } catch (error) {
    throw new Error(`Cannot inspect ONNX model '${modelPath}': ${error.message}`, { cause: error });
  }
  if (!model.graph) throw new Error(`ONNX model '${modelPath}' does not contain a graph`);

  const initializers = new Set((model.graph.initializer ?? []).map(({ name }) => name));
  return {
    inputs: (model.graph.input ?? [])
      .filter(({ name }) => !initializers.has(name))
      .map(readValueInfo),
    outputs: (model.graph.output ?? []).map(readValueInfo)
  };
}

async function loadOnnxProto(importModule = (specifier) => import(specifier)) {
  try {
    const module = await importModule('onnx-proto');
    return module.default ?? module;
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      /Cannot find package ['"]onnx-proto['"]/.test(error.message)
    ) {
      throw new Error(
        "Embedding model validation requires onnx-proto. Install it with 'npm add onnx-proto'.",
        { cause: error }
      );
    }
    throw error;
  }
}

function validateOnnxEmbeddingModel(inspection, descriptor) {
  const inputIds = inspection.inputs.find(({ name }) => name === 'input_ids');
  if (!inputIds) throw new Error("Embedding model must expose the input 'input_ids'");

  const unsupportedInputs = inspection.inputs.filter(({ name }) => !STANDARD_INPUT_NAMES.has(name));
  if (unsupportedInputs.length > 0) {
    throw new Error(
      `Embedding model has unsupported inputs: ${unsupportedInputs.map(({ name }) => name).join(', ')}`
    );
  }
  for (const input of inspection.inputs) {
    if (input.type !== 'int64') {
      throw new Error(
        `Embedding model input '${input.name}' must be int64, received ${input.type}`
      );
    }
    if (input.dimensions.length !== 2) {
      throw new Error(
        `Embedding model input '${input.name}' must have rank 2, received rank ${input.dimensions.length}`
      );
    }
  }

  const output = inspection.outputs.find(({ name }) => name === descriptor.output.name);
  if (!output) {
    throw new Error(
      `Embedding model output '${descriptor.output.name}' not found. Available outputs: ${inspection.outputs.map(({ name }) => name).join(', ') || 'none'}`
    );
  }
  if (output.type !== 'float32' && output.type !== 'float64') {
    throw new Error(
      `Embedding model output '${output.name}' must be float32 or float64, received ${output.type}`
    );
  }

  const expectedRanks = descriptor.output.pooling === 'none' ? [1, 2] : [3];
  if (!expectedRanks.includes(output.dimensions.length)) {
    throw new Error(
      `Embedding model output '${output.name}' has rank ${output.dimensions.length}; pooling '${descriptor.output.pooling}' requires rank ${expectedRanks.join(' or ')}`
    );
  }
  const outputDimensions = output.dimensions.at(-1);
  if (typeof outputDimensions === 'number' && outputDimensions !== descriptor.dimensions) {
    throw new Error(
      `Embedding model output '${output.name}' has ${outputDimensions} dimensions; expected ${descriptor.dimensions}`
    );
  }
  return inspection;
}

function readValueInfo(value) {
  const tensor = value.type?.tensorType;
  if (!tensor) {
    return { name: value.name, type: 'non-tensor', dimensions: [] };
  }
  return {
    name: value.name,
    type: TENSOR_TYPES.get(tensor.elemType) ?? `tensor(${tensor.elemType})`,
    dimensions: (tensor.shape?.dim ?? []).map(readDimension)
  };
}

function readDimension(dimension) {
  if (dimension.dimParam) return dimension.dimParam;
  if (dimension.dimValue === undefined || dimension.dimValue === null) return undefined;
  const value =
    typeof dimension.dimValue === 'number' ? dimension.dimValue : dimension.dimValue.toNumber();
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export { inspectOnnxModelFile, loadOnnxProto, validateOnnxEmbeddingModel };
