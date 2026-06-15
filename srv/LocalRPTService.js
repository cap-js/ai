import cds from '@sap/cds';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import AICoreService from './AICoreService.js';

const LOG = cds.log('@cap-js/ai');

const MODEL_ID = 'SAP/sap-rpt-1-oss';
const MODEL_FILE = '2025-11-04_sap-rpt-one-oss.pt';
const MODEL_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/${MODEL_FILE}`;
const HF_INFERENCE_URL = `https://api-inference.huggingface.co/models/${MODEL_ID}`;
const INFER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../lib/rpt/infer.py');

// Sentence embedder downloaded by sap_rpt_oss at classifier init time
const EMBEDDER_ID = 'sentence-transformers/all-MiniLM-L6-v2';
const EMBEDDER_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'model.safetensors',
  '1_Pooling/config.json',
];

// ─── Cache helpers ────────────────────────────────────────────────────────────

function _cacheDir() {
  return (
    cds.env.requires?.AICore?.cacheDir ??
    join(process.env.HOME ?? process.cwd(), '.cache', 'sap-rpt-1-oss')
  );
}

function _modelPath() {
  return join(_cacheDir(), MODEL_FILE);
}

/** HuggingFace hub cache root — transformers/huggingface_hub look here. */
function _hfHome() {
  return join(_cacheDir(), 'hf');
}

/**
 * Returns the directory where huggingface_hub caches a given repo, following
 * the standard layout: <HF_HOME>/hub/models--<org>--<name>/snapshots/<ref>/
 */
function _hfRepoCache(repoId, ref = 'main') {
  const repoDir = 'models--' + repoId.replace('/', '--');
  return join(_hfHome(), 'hub', repoDir, 'snapshots', ref);
}

function _hfToken() {
  return cds.env.rpt?.hfToken ?? '';
}

// ─── Download helpers ─────────────────────────────────────────────────────────

/** Download a single URL to dest with a live progress bar on stderr. */
async function _downloadFile(url, dest, label, headers = {}) {
  mkdirSync(dirname(dest), { recursive: true });

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Access denied when downloading ${label} (HTTP ${res.status}).\n\n` +
        `  SAP/sap-rpt-1-oss is a gated model — you need a HuggingFace account and must\n` +
        `  accept the model licence at https://huggingface.co/${MODEL_ID}\n\n` +
        `  Then provide your HF token via .cdsrc-private.json (gitignored):\n` +
        `        { "cds": { "rpt": { "hfToken": "hf_..." } } }\n\n` +
        `  Generate a token at https://huggingface.co/settings/tokens\n` +
        `  Required permission: "Read access to contents of all public gated repos you can access"`
      );
    }
    throw new Error(`Download failed for ${label}: ${res.status} ${res.statusText}`);
  }

  const total = parseInt(res.headers.get('content-length') ?? '0', 10);
  let downloaded = 0;
  const startTime = Date.now();
  const BAR_WIDTH = 30;

  function _drawBar() {
    const pct = total > 0 ? downloaded / total : 0;
    const filled = Math.round(BAR_WIDTH * pct);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = elapsed > 0 ? downloaded / elapsed : 0;
    const eta = total > 0 && speed > 0 ? Math.ceil((total - downloaded) / speed) + 's' : '…';
    const pctStr = total > 0 ? (pct * 100).toFixed(1).padStart(5) + '%' : '  …  ';
    process.stderr.write(
      `\r  ${bar}  ${pctStr}  ${mb(downloaded)}${total > 0 ? ' / ' + mb(total) : ''}  ${speed > 0 ? mb(speed) + '/s' : ''}  ETA ${eta}   `
    );
  }

  const { Transform } = await import('node:stream');
  const tracker = new Transform({
    transform(chunk, _enc, cb) { downloaded += chunk.length; _drawBar(); cb(null, chunk); }
  });

  process.stderr.write(`\n  Downloading ${label}\n`);
  _drawBar();
  await pipeline(res.body, tracker, createWriteStream(dest));
  process.stderr.write('\n');
}

/** Ensure the RPT-1 checkpoint is on disk. */
async function ensureModel() {
  const dest = _modelPath();
  if (existsSync(dest) && (await stat(dest)).size > 0) return dest;
  LOG.info(`[Local RPT] downloading model checkpoint from ${MODEL_URL}`);
  const token = _hfToken();
  await _downloadFile(MODEL_URL, dest, `${MODEL_FILE} (${MODEL_ID})`,
    token ? { Authorization: `Bearer ${token}` } : {});
  process.stderr.write('  Download complete.\n\n');
  return dest;
}

/**
 * Ensure the sentence embedder is in the HF hub cache layout so
 * huggingface_hub finds it without hitting the network.
 *
 * Layout: <HF_HOME>/hub/models--sentence-transformers--all-MiniLM-L6-v2/
 *           snapshots/main/<file>
 */
async function ensureEmbedder() {
  const snapshotDir = _hfRepoCache(EMBEDDER_ID);
  const token = _hfToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const base = `https://huggingface.co/${EMBEDDER_ID}/resolve/main`;

  const missing = await Promise.all(
    EMBEDDER_FILES.map(async (file) => {
      const dest = join(snapshotDir, file);
      if (existsSync(dest) && (await stat(dest)).size > 0) return null;
      return file;
    })
  ).then((files) => files.filter(Boolean));

  if (missing.length) {
    LOG.info(`[Local RPT] downloading sentence embedder (${EMBEDDER_ID})`);
    await Promise.all(
      missing.map((file) =>
        _downloadFile(`${base}/${file}`, join(snapshotDir, file), `${EMBEDDER_ID}/${file}`, headers)
      )
    );
  }

  // Write the refs/main pointer that huggingface_hub uses to resolve the snapshot
  const refPath = join(_hfHome(), 'hub', 'models--' + EMBEDDER_ID.replace('/', '--'), 'refs', 'main');
  if (!existsSync(refPath)) {
    mkdirSync(dirname(refPath), { recursive: true });
    writeFileSync(refPath, 'main');
  }

  if (missing.length) process.stderr.write('  Embedder ready.\n\n');
}

// ─── HuggingFace Inference API mode ──────────────────────────────────────────

export class HFInferenceRPTService extends AICoreService {
  async _getToken() {
    const token = _hfToken();
    if (!token)
      throw new cds.error(
        'Missing HuggingFace token. Set cds.requires.AICore.credentials.token or HF_TOKEN.'
      );
    return token;
  }

  async _predictRowColumns(req) {
    const token = await this._getToken();
    const { prediction_config, index_column, rows, data_schema } = req.data;

    LOG.debug(`[HF Inference] SAP/sap-rpt-1-oss — ${rows.length} row(s)`);

    const res = await fetch(HF_INFERENCE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          data: rows,
          target_columns: prediction_config.target_columns,
          index_column,
          ...(data_schema && { data_schema })
        }
      })
    });

    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      const detail = ct.includes('json') ? JSON.stringify(await res.json()) : await res.text();
      LOG.error(`[HF Inference] ${res.status}: ${detail}`);
      return {};
    }

    const result = await res.json();
    if (result.error) {
      LOG.error(`[HF Inference] model error: ${result.error}`);
      return {};
    }
    return result?.predictions !== undefined ? result : { predictions: result };
  }
}

// ─── Local Python subprocess mode ────────────────────────────────────────────

export class LocalSubprocessRPTService extends AICoreService {
  /** @type {import('node:child_process').ChildProcess | null} */
  _proc = null;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  _pending = new Map();
  _nextId = 1;
  /** Promise that resolves once the subprocess is ready (set in _boot). */
  _ready = null;

  init() {
    // Defer boot until after CDS has finished loading .env and all config,
    // so HF_TOKEN and other env vars are reliably available.
    cds.once('served', () => {
      this._ready = this._boot();
      this._ready.catch((err) => {
        if (!err.message.includes('sap_rpt_oss not installed'))
          LOG.error('[Local RPT] startup failed:', err);
      });
    });
    return super.init();
  }

  async _boot() {
    // 1. Download model checkpoint + sentence embedder if needed
    const modelPath = await ensureModel();
    await ensureEmbedder();

    // 2. Spawn Python inference server
    const python = cds.env.requires?.AICore?.python ?? 'python3';
    LOG.info('[Local RPT] starting Python inference process…');

    const token = _hfToken();
    this._proc = spawn(python, [INFER_SCRIPT, modelPath], {
      env: {
        ...process.env,
        HF_TOKEN: token,
        HUGGING_FACE_HUB_TOKEN: token,   // legacy env var checked by some HF libs
        HF_HOME: _hfHome(),              // point Python at our pre-downloaded cache
        RPT_MODEL_PATH: modelPath
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Stderr from Python — buffer lines so we can detect known errors
    this._proc.stderr.setEncoding('utf8');
    const stderrLines = [];
    this._proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        stderrLines.push(line);
        LOG.info(`[Local RPT py] ${line}`);
      }
    });

    // Each stdout line is a JSON response to a pending request
    const rl = createInterface({ input: this._proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); }
      catch { LOG.warn(`[Local RPT] unexpected stdout: ${line}`); return; }
      const h = this._pending.get(msg.id);
      if (!h) return;
      this._pending.delete(msg.id);
      msg.error ? h.reject(new Error(msg.error)) : h.resolve(msg.result);
    });

    this._proc.on('exit', (code) => {
      const missingPackage = stderrLines.some((l) => l.includes('sap_rpt_oss package not found'));
      if (missingPackage) {
        const border = '─'.repeat(60);
        process.stderr.write(
          `\n  ┌${border}┐\n` +
          `  │  sap_rpt_oss Python package is not installed.            │\n` +
          `  │                                                          │\n` +
          `  │  Install it once with:                                   │\n` +
          `  │    pip install git+https://github.com/SAP-samples/       │\n` +
          `  │                sap-rpt-1-oss                             │\n` +
          `  │                                                          │\n` +
          `  │  Requires: Python ≥3.11, torch, transformers             │\n` +
          `  └${border}┘\n\n`
        );
      }
      if (this._pending.size > 0) {
        const err = missingPackage
          ? new Error('sap_rpt_oss not installed — run: pip install git+https://github.com/SAP-samples/sap-rpt-1-oss')
          : new Error(`Python inference process exited (code ${code})`);
        for (const [, h] of this._pending) h.reject(err);
        this._pending.clear();
      }
      this._proc = null;
      this._ready = null;
    });

    // Python sends {"id":0,"result":"ready"} once the model is loaded
    await new Promise((resolve, reject) => this._pending.set(0, { resolve, reject }));
    LOG.info('[Local RPT] model ready');
  }

  async _predictRowColumns(req) {
    if (!this._ready) this._ready = this._boot();
    await this._ready;

    const id = this._nextId++;
    LOG.debug(`[Local RPT] request #${id} — ${req.data.rows?.length ?? '?'} row(s)`);

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._proc.stdin.write(JSON.stringify({ id, data: req.data }) + '\n');
    });
  }
}

// ─── Default export ───────────────────────────────────────────────────────────

/**
 * LocalRPTService — used by both `AICore-local` and `AICore-hf` kinds.
 *
 * Set `cds.requires.AICore.local: true` to run the model entirely on this
 * machine (requires Python ≥3.11 + `sap_rpt_oss` installed).
 * Omit `local` (or set it to false) to call the HuggingFace Inference API.
 *
 * On first use with `local: true` the model checkpoint (~65 MB) is downloaded
 * from HuggingFace automatically during CDS startup and cached in
 * `~/.cache/SAP/sap-rpt-1-oss/` (override with `cacheDir`).
 */
export default class LocalRPTService extends AICoreService {
  init() {
    const cfg = cds.env.requires?.AICore ?? {};
    if (cfg.local === true) {
      const backend = new LocalSubprocessRPTService();
      backend.init(); // registers cds.once('served') boot
      this._predictRowColumns = backend._predictRowColumns.bind(backend);
      this._getToken = () => Promise.resolve(_hfToken());
      // _ready is set by backend after 'served' fires; forward it lazily
      Object.defineProperty(this, '_ready', { get: () => backend._ready });
    } else {
      const backend = new HFInferenceRPTService();
      this._predictRowColumns = backend._predictRowColumns.bind(backend);
      this._getToken = backend._getToken.bind(backend);
    }
    return super.init();
  }
}
