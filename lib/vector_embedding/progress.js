import path from 'node:path';
import { createCliStyle, displayText, formatElapsed } from './cli-style.js';

// Human-readable formatters shared by the CLI and log progress reporters.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '?';
  return `${formatBytes(bytesPerSecond)}/s`;
}

// Derive rate/ETA from cumulative counters. Returns undefined fields until enough
// data has accumulated to make the estimate meaningful.
function estimate(downloadedBytes, totalBytes, elapsedMs) {
  if (
    !Number.isFinite(elapsedMs) ||
    !(elapsedMs > 0) ||
    !Number.isFinite(downloadedBytes) ||
    !(downloadedBytes > 0)
  )
    return {};
  const bytesPerSecond = (downloadedBytes / elapsedMs) * 1000;
  const remaining =
    Number.isFinite(totalBytes) && totalBytes > 0
      ? Math.max(0, totalBytes - downloadedBytes)
      : undefined;
  return {
    bytesPerSecond,
    etaMs: remaining === undefined ? undefined : (remaining / bytesPerSecond) * 1000
  };
}

function overallPercent(downloadedBytes, totalBytes) {
  if (!Number.isFinite(downloadedBytes) || !Number.isFinite(totalBytes) || !(totalBytes > 0))
    return undefined;
  return Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
}

// A TTY reporter keeps a single status line updated in place; a non-TTY reporter
// (piped output, CI) prints one plain line per milestone instead of spamming \r.
function createCliProgressReporter({ stdout = process.stdout, env = process.env } = {}) {
  const tty = Boolean(stdout.isTTY) && env.TERM !== 'dumb';
  const style = createCliStyle(stdout, env);
  const throttleMs = 100;
  let lastRenderAt = -Infinity;
  let lineOpen = false;
  let waitingReported = false;

  const clearLine = () => {
    const shouldClear = tty && lineOpen;
    lineOpen = false;
    if (shouldClear) stdout.write('\r\x1b[K');
  };
  const writeLine = (text) => {
    clearLine();
    stdout.write(`${text}\n`);
  };

  function report(event) {
    switch (event.phase) {
      case 'plan': {
        lastRenderAt = -Infinity;
        if (event.pendingFiles === 0) {
          writeLine(`Reusing ${fileCount(event.totalFiles)} already downloaded.`);
          break;
        }
        writeLine(
          `Downloading ${fileCount(event.pendingFiles)} (~${formatBytes(event.totalBytes)})` +
            (event.skippedFiles ? `; ${event.skippedFiles} already present` : '')
        );
        break;
      }
      case 'waiting':
        if (!waitingReported) {
          writeLine('Waiting for another model installation');
          waitingReported = true;
        }
        break;
      case 'file:start':
        lastRenderAt = -Infinity;
        break;
      case 'progress': {
        if (!tty) break;
        const now = Date.now();
        if (now - lastRenderAt < throttleMs) break;
        lastRenderAt = now;
        const percent = overallPercent(event.downloadedBytes, event.totalBytes);
        const { bytesPerSecond, etaMs } = estimate(
          event.downloadedBytes,
          event.totalBytes,
          event.elapsedMs
        );
        const parts = [
          percent === undefined ? '' : `${percent}%`,
          `${formatBytes(event.downloadedBytes)}/${formatBytes(event.totalBytes)}`,
          bytesPerSecond ? formatRate(bytesPerSecond) : '',
          etaMs === undefined ? '' : `ETA ${formatDuration(etaMs)}`
        ].filter(Boolean);
        // Leave the final column unused so the transient line never auto-wraps.
        const columns =
          Number.isFinite(stdout.columns) && stdout.columns > 0 ? Math.floor(stdout.columns) : 100;
        const width = Math.max(1, columns - 1);
        while (parts.length > 2 && parts.join('  ').length > width) parts.pop();
        let text = parts.join('  ');
        const barWidth = Math.min(20, width - text.length - 4);
        if (percent !== undefined && barWidth >= 6) {
          const filled = Math.floor((percent / 100) * barWidth);
          text = `[${'#'.repeat(filled)}${'.'.repeat(barWidth - filled)}]  ${text}`;
        }
        const available = width - text.length - 2;
        if (event.name && available >= 4) {
          text += `  ${style.dim(fitText(displayText(basename(event.name)), available))}`;
        } else {
          text = fitText(text, width);
        }
        stdout.write(`\r${text}\x1b[K`);
        lineOpen = true;
        break;
      }
      case 'done':
        clearLine();
        if (event.totalBytes > 0) {
          writeLine(
            `Download complete (${formatBytes(event.totalBytes)} in ${formatDuration(event.elapsedMs)})`
          );
        }
        break;
      case 'validate:start':
        writeLine('Validating ONNX model');
        break;
      default:
        break;
    }
  }
  report.close = clearLine;
  return report;
}

// The server-side reporter logs plain, throttled lines (no \r control codes) so
// progress is legible in application logs during ad-hoc startup provisioning.
function createLogProgressReporter({ log, throttleMs = 3000 } = {}) {
  if (typeof log !== 'function')
    throw new TypeError('createLogProgressReporter requires a log function');
  let lastLogAt = 0;

  return function report(event) {
    switch (event.phase) {
      case 'plan':
        if (event.pendingFiles > 0) {
          log(
            `Downloading embedding model: ${fileCount(event.pendingFiles)}, ~${formatBytes(event.totalBytes)}` +
              (event.skippedFiles ? ` (${event.skippedFiles} already present)` : '')
          );
        }
        break;
      case 'progress': {
        const now = Date.now();
        if (now - lastLogAt < throttleMs) break;
        lastLogAt = now;
        const percent = overallPercent(event.downloadedBytes, event.totalBytes);
        const { etaMs } = estimate(event.downloadedBytes, event.totalBytes, event.elapsedMs);
        log(
          `Downloading embedding model: ${percent === undefined ? '' : `${percent}%, `}` +
            `${formatBytes(event.downloadedBytes)}/${formatBytes(event.totalBytes)}` +
            (etaMs === undefined ? '' : `, ETA ${formatDuration(etaMs)}`)
        );
        break;
      }
      case 'done':
        if (event.totalBytes > 0) {
          log(
            `Embedding model download complete (${formatBytes(event.totalBytes)} in ${formatDuration(event.elapsedMs)}).`
          );
        }
        break;
      case 'waiting':
        log('Waiting for another embedding model installation.');
        break;
      case 'validate:start':
        log('Validating embedding model.');
        break;
      case 'validate:done':
        log(
          `Embedding model validated (${event.dimensions} dimensions in ${formatElapsed(event.elapsedMs)}).`
        );
        break;
      default:
        break;
    }
  };
}

function fileCount(count) {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function fitText(text, width) {
  if (text.length <= width) return text;
  return width >= 4 ? `${text.slice(0, width - 3)}...` : text.slice(0, width);
}

function basename(name) {
  return typeof name === 'string' ? path.posix.basename(name) : name;
}

export {
  createCliProgressReporter,
  createLogProgressReporter,
  estimate,
  formatBytes,
  formatDuration,
  formatRate,
  overallPercent
};
