const MODEL_REPOSITORY = 'model';
const MODEL_INFO_FIELDS = [
  'cardData',
  'config',
  'filePaths',
  'library_name',
  'sha',
  'tags',
  'transformersInfo'
];

function createHuggingFaceClient(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    hubUrl = options.origin,
    accessToken = process.env.HF_TOKEN,
    bindings
  } = options;
  const common = { fetch: fetchImpl, hubUrl, accessToken };
  const loadedBindings = resolveBindings(bindings);

  return {
    async getModelInfo(repository) {
      const { modelInfo } = await loadedBindings;
      return modelInfo({
        name: repository,
        additionalFields: MODEL_INFO_FIELDS,
        ...common
      });
    },

    async getFiles(repository, revision) {
      const { listFiles } = await loadedBindings;
      const files = [];
      for await (const file of listFiles({
        repo: { type: MODEL_REPOSITORY, name: repository },
        revision,
        recursive: true,
        ...common
      })) {
        if (file.type === 'file') files.push(file);
      }
      return files;
    },

    async getFile(repository, revision, remotePath) {
      const { downloadFile } = await loadedBindings;
      const file = await downloadFile({
        repo: { type: MODEL_REPOSITORY, name: repository },
        path: remotePath,
        revision,
        xet: false,
        ...common
      });
      if (!file) {
        throw new Error(
          `Hugging Face model '${repository}' does not contain '${remotePath}' at ${revision}`
        );
      }
      return Buffer.from(await file.arrayBuffer());
    }
  };
}

async function resolveBindings(bindings) {
  if (
    typeof bindings?.modelInfo === 'function' &&
    typeof bindings?.listFiles === 'function' &&
    typeof bindings?.downloadFile === 'function'
  ) {
    return bindings;
  }
  return { ...(await loadHuggingFaceHub()), ...bindings };
}

async function loadHuggingFaceHub(importModule = (specifier) => import(specifier)) {
  try {
    return await importModule('@huggingface/hub');
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      /Cannot find package ['"]@huggingface\/hub['"]/.test(error.message)
    ) {
      throw new Error(
        "Automatic Hugging Face model discovery requires @huggingface/hub. Install it with 'npm add @huggingface/hub'.",
        { cause: error }
      );
    }
    throw error;
  }
}

export { createHuggingFaceClient, loadHuggingFaceHub };
