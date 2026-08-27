import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import onnxProto from 'onnx-proto';

import {
  inspectOnnxModelFile,
  validateOnnxEmbeddingModel
} from '../lib/vector_embedding/onnx-inspection.js';

const { onnx } = onnxProto;
const descriptor = {
  dimensions: 384,
  output: { name: 'last_hidden_state', pooling: 'mean' }
};

describe('ONNX embedding-model inspection', () => {
  test('reads and accepts a standard token-level encoder graph', async () => {
    const inspection = await inspect(
      fixture({
        inputs: [
          valueInfo('input_ids', 7, ['batch', 'sequence']),
          valueInfo('attention_mask', 7, ['batch', 'sequence'])
        ],
        outputs: [valueInfo('last_hidden_state', 1, ['batch', 'sequence', 384])]
      })
    );

    assert.deepEqual(inspection, {
      inputs: [
        { name: 'input_ids', type: 'int64', dimensions: ['batch', 'sequence'] },
        { name: 'attention_mask', type: 'int64', dimensions: ['batch', 'sequence'] }
      ],
      outputs: [
        {
          name: 'last_hidden_state',
          type: 'float32',
          dimensions: ['batch', 'sequence', 384]
        }
      ]
    });
    assert.deepEqual(validateOnnxEmbeddingModel(inspection, descriptor), inspection);
  });

  test('rejects decoder logits instead of treating them as embeddings', async () => {
    const inspection = await inspect(
      fixture({
        inputs: [valueInfo('input_ids', 7, ['batch', 'sequence'])],
        outputs: [valueInfo('logits', 1, ['batch', 'sequence', 250002])]
      })
    );

    assert.throws(
      () => validateOnnxEmbeddingModel(inspection, descriptor),
      /output 'last_hidden_state' not found\. Available outputs: logits/
    );
  });

  test('rejects graph contracts the synchronous encoder adapter cannot execute', async () => {
    const inspection = await inspect(
      fixture({
        inputs: [
          valueInfo('input_ids', 7, ['batch', 'sequence']),
          valueInfo('position_ids', 7, ['batch', 'sequence'])
        ],
        outputs: [valueInfo('last_hidden_state', 1, ['batch', 'sequence', 384])]
      })
    );

    assert.throws(
      () => validateOnnxEmbeddingModel(inspection, descriptor),
      /unsupported inputs: position_ids/
    );
  });

  test('rejects an output whose final dimension differs from the discovered model configuration', async () => {
    const inspection = await inspect(
      fixture({
        inputs: [valueInfo('input_ids', 7, ['batch', 'sequence'])],
        outputs: [valueInfo('last_hidden_state', 1, ['batch', 'sequence', 768])]
      })
    );

    assert.throws(
      () => validateOnnxEmbeddingModel(inspection, descriptor),
      /has 768 dimensions; expected 384/
    );
  });
});

async function inspect(model) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-js-ai-onnx-'));
  const modelPath = path.join(directory, 'model.onnx');
  try {
    await fs.writeFile(modelPath, onnx.ModelProto.encode(model).finish());
    return await inspectOnnxModelFile(modelPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function fixture(graph) {
  return onnx.ModelProto.create({
    graph: onnx.GraphProto.create({ input: graph.inputs, output: graph.outputs })
  });
}

function valueInfo(name, elemType, dimensions) {
  return onnx.ValueInfoProto.create({
    name,
    type: onnx.TypeProto.create({
      tensorType: onnx.TypeProto.Tensor.create({
        elemType,
        shape: onnx.TensorShapeProto.create({
          dim: dimensions.map((dimension) =>
            typeof dimension === 'number'
              ? onnx.TensorShapeProto.Dimension.create({ dimValue: dimension })
              : onnx.TensorShapeProto.Dimension.create({ dimParam: dimension })
          )
        })
      })
    })
  });
}
