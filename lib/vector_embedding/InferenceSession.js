// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//
// Synchronous counterpart to onnxruntime-node's session handler. SQLite user
// defined functions cannot await the public asynchronous InferenceSession API.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const SUPPORTED_ONNX_RUNTIME_VERSION = '1.20.1';
const runtimeVersion = require('onnxruntime-node/package.json').version;

if (runtimeVersion !== SUPPORTED_ONNX_RUNTIME_VERSION) {
  throw new Error(
    `Unsupported onnxruntime-node version ${runtimeVersion}; @cap-js/ai requires ${SUPPORTED_ONNX_RUNTIME_VERSION} because its synchronous SQLite integration uses the runtime's private native API.`
  );
}

const ort = require('onnxruntime-node');
const binding = require('onnxruntime-node/dist/binding.js').binding;

class InferenceSession {
  constructor(handler) {
    this.handler = handler;
  }

  get inputNames() {
    return this.handler.inputNames;
  }

  get outputNames() {
    return this.handler.outputNames;
  }

  run(feeds) {
    if (
      typeof feeds !== 'object' ||
      feeds === null ||
      feeds instanceof ort.Tensor ||
      Array.isArray(feeds)
    ) {
      throw new TypeError(
        "'feeds' must be an object that uses input names as keys and tensors as values."
      );
    }

    for (const name of this.handler.inputNames) {
      if (feeds[name] === undefined) throw new Error(`input '${name}' is missing in 'feeds'.`);
    }

    const fetches = Object.fromEntries(this.handler.outputNames.map((name) => [name, null]));
    const results = this.handler.run(feeds, fetches, {});
    const output = {};

    for (const key in results) {
      const result = results[key];
      output[key] =
        result instanceof ort.Tensor
          ? result
          : new ort.Tensor(result.type, result.data, result.dims);
    }

    return output;
  }

  dispose() {
    const handler = this.handler;
    if (!handler) return;
    this.handler = undefined;
    return handler.dispose();
  }

  static async create(pathOrBuffer) {
    if (typeof pathOrBuffer !== 'string' && !(pathOrBuffer instanceof Uint8Array)) {
      throw new TypeError('Expected an ONNX model path or Uint8Array');
    }
    return new InferenceSession(new SynchronousSessionHandler(pathOrBuffer));
  }
}

class SynchronousSessionHandler {
  constructor(pathOrBuffer) {
    this.session = new binding.InferenceSession();
    try {
      if (typeof pathOrBuffer === 'string') {
        this.session.loadModel(pathOrBuffer, {});
      } else {
        this.session.loadModel(
          pathOrBuffer.buffer,
          pathOrBuffer.byteOffset,
          pathOrBuffer.byteLength,
          {}
        );
      }
      this.inputNames = this.session.inputNames;
      this.outputNames = this.session.outputNames;
    } catch (error) {
      try {
        this.session.dispose();
      } catch {
        // Preserve the model loading error.
      }
      throw error;
    }
  }

  run(feeds, fetches, options) {
    return this.session.run(feeds, fetches, options);
  }

  dispose() {
    this.session.dispose();
  }
}

const { Tensor } = ort;

export { InferenceSession, Tensor };
