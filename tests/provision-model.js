import fs from 'node:fs/promises';

import { validateEmbeddingModel } from '../lib/vector_embedding/embedding.js';
import {
  getModelDirectory,
  getModelRoot,
  provisionModel
} from '../lib/vector_embedding/model-utils.js';

const lockUrl = new URL('./fixtures/Xenova/all-MiniLM-L6-v2/embedding.lock.json', import.meta.url);
const { formatVersion, ...model } = JSON.parse(await fs.readFile(lockUrl, 'utf8'));
if (formatVersion !== 1) throw new Error(`Unsupported test model lock version ${formatVersion}`);

const modelDir = getModelDirectory(getModelRoot(undefined, process.cwd()), model.repository);
await provisionModel(model, { directory: modelDir, validate: validateEmbeddingModel });
console.log(`Installed ${model.repository} in ${modelDir}`);
