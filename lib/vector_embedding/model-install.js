import { setTimeout as delay } from 'node:timers/promises';
import { discoverModel } from './model-discovery.js';
import {
  MODEL_PROVISIONING_IN_PROGRESS,
  assertSafeRepository,
  getModelDirectory,
  getModelRoot,
  provisionModel,
  readModelLock
} from './model-utils.js';

const MODEL_PROVISION_TIMEOUT_MS = 15 * 60 * 1000;
const MODEL_PROVISION_RETRY_MS = 250;

async function installModel(repository, options = {}) {
  assertSafeRepository(repository);
  const modelRoot = getModelRoot(options.directory, options.root, options.home);
  const modelDir = getModelDirectory(modelRoot, repository);
  const discover = options.discover ?? discoverModel;

  let model;
  try {
    model = await readModelLock(modelDir);
    assertRepository(model, repository, modelDir);
  } catch (error) {
    if (!/Embedding model lock not found/.test(error.message)) throw error;
    model = await discover(repository, {
      fetchImpl: options.fetchImpl,
      hubUrl: options.hubUrl
    });
    assertRepository(model, repository, modelDir);
  }

  const deadline = Date.now() + (options.timeoutMs ?? MODEL_PROVISION_TIMEOUT_MS);
  const retryMs = options.retryMs ?? MODEL_PROVISION_RETRY_MS;
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await provisionModel(model, {
        directory: modelDir,
        fetchImpl: options.fetchImpl,
        hubUrl: options.hubUrl,
        validate: options.validate
      });

      return { model, modelDir, modelRoot };
    } catch (error) {
      if (error.code !== MODEL_PROVISIONING_IN_PROGRESS) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for embedding model provisioning in ${modelDir}`, {
          cause: error
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(Math.min(retryMs, remaining));
    }
  }
}

function assertRepository(model, repository, modelDir) {
  if (model.repository !== repository) {
    throw new Error(
      `Embedding model directory ${modelDir} contains ${model.repository}, not ${repository}. Choose another directory or remove it explicitly before installing the configured model.`
    );
  }
}

export { installModel };
