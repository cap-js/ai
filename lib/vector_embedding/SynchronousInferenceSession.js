// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//
// Synchronous counterpart to onnxruntime-node's public InferenceSession. SQLite
// user-defined functions cannot await its asynchronous run API.
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

class SynchronousInferenceSession {
  #session;
  #inputNames;
  #outputNames;

  constructor(pathOrBuffer) {
    if (typeof pathOrBuffer !== 'string' && !(pathOrBuffer instanceof Uint8Array)) {
      throw new TypeError('Expected an ONNX model path or Uint8Array');
    }

    const session = new binding.InferenceSession();
    try {
      if (typeof pathOrBuffer === 'string') {
        session.loadModel(pathOrBuffer, {});
      } else {
        session.loadModel(
          pathOrBuffer.buffer,
          pathOrBuffer.byteOffset,
          pathOrBuffer.byteLength,
          {}
        );
      }
      this.#inputNames = Object.freeze([...session.inputNames]);
      this.#outputNames = Object.freeze([...session.outputNames]);
      this.#session = session;
    } catch (error) {
      try {
        session.dispose();
      } catch {
        // Preserve the model loading error.
      }
      throw error;
    }
  }

  get inputNames() {
    return this.#inputNames;
  }

  get outputNames() {
    return this.#outputNames;
  }

  run(feeds) {
    const session = this.#session;
    if (!session) throw new Error('Inference session has been disposed');
    if (typeof feeds !== 'object' || feeds === null || Array.isArray(feeds)) {
      throw new TypeError("'feeds' must be an object that uses input names as keys.");
    }

    const nativeFeeds = Object.fromEntries(
      this.#inputNames.map((name) => {
        const feed = feeds[name];
        if (feed === undefined) throw new Error(`input '${name}' is missing in 'feeds'.`);
        return [
          name,
          feed instanceof ort.Tensor ? feed : new ort.Tensor(feed.type, feed.data, feed.dims)
        ];
      })
    );
    const fetches = Object.fromEntries(this.#outputNames.map((name) => [name, null]));
    const results = session.run(nativeFeeds, fetches, {});

    return Object.fromEntries(
      Object.entries(results).map(([name, result]) => [
        name,
        result instanceof ort.Tensor
          ? result
          : new ort.Tensor(result.type, result.data, result.dims)
      ])
    );
  }

  dispose() {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    session.dispose();
  }

  static async create(pathOrBuffer) {
    return new SynchronousInferenceSession(pathOrBuffer);
  }
}

export { SynchronousInferenceSession };
