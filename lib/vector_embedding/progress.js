import path from 'node:path';

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
  if (!(elapsedMs > 0) || !(downloadedBytes > 0)) return {};
  const bytesPerSecond = (downloadedBytes / elapsedMs) * 1000;
  const remaining = Math.max(0, totalBytes - downloadedBytes);
  return {
    bytesPerSecond,
    etaMs: bytesPerSecond > 0 ? (remaining / bytesPerSecond) * 1000 : undefined
  };
}

function overallPercent(downloadedBytes, totalBytes) {
  if (!(totalBytes > 0)) return undefined;
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
}

// A TTY reporter keeps a single status line updated in place; a non-TTY reporter
// (piped output, CI) prints one plain line per milestone instead of spamming \r.
function createCliProgressReporter({ stdout = process.stdout } = {}) {
  const tty = Boolean(stdout.isTTY);
  const throttleMs = 100;
  let lastRenderAt = 0;
  let lineOpen = false;

  const clearLine = () => {
    const shouldClear = tty && lineOpen;
    lineOpen = false;
    if (shouldClear) stdout.write('\r\x1b[K');
  };
  const writeLine = (text) => {
    if (tty) {
      stdout.write(`\r${text}\x1b[K`);
      lineOpen = true;
    } else {
      stdout.write(`${text}\n`);
    }
  };

  function report(event) {
    switch (event.phase) {
      case 'plan': {
        if (event.pendingFiles === 0) {
          writeLine(`All ${event.totalFiles} file(s) already downloaded.`);
          clearLine();
          break;
        }
        writeLine(
          `Downloading ${event.pendingFiles} file(s) (~${formatBytes(event.totalBytes)})` +
            (event.skippedFiles ? `; ${event.skippedFiles} already present` : '')
        );
        if (tty) stdout.write('\n');
        lineOpen = false;
        break;
      }
      case 'file:skip':
        if (!tty) writeLine(`  skip ${event.name} (${formatBytes(event.size)}, already present)`);
        break;
      case 'progress': {
        const now = Date.now();
        if (tty && now - lastRenderAt < throttleMs) break;
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
          etaMs === undefined ? '' : `ETA ${formatDuration(etaMs)}`,
          basename(event.name)
        ].filter(Boolean);
        if (tty) writeLine(parts.join('  '));
        break;
      }
      case 'file:done':
        if (!tty) writeLine(`  done ${event.name} (${formatBytes(event.size)})`);
        break;
      case 'done':
        clearLine();
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
            `Downloading embedding model: ${event.pendingFiles} file(s), ~${formatBytes(event.totalBytes)}` +
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
        log(
          `Embedding model download complete (${formatBytes(event.totalBytes)} in ${formatDuration(event.elapsedMs)}).`
        );
        break;
      default:
        break;
    }
  };
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
