function createCliStyle(stream = process.stdout, env = process.env) {
  const enabled = Boolean(stream.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  const wrap = (open, close) => (value) =>
    enabled ? `\x1b[${open}m${value}\x1b[${close}m` : String(value);
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    success: wrap(32, 39),
    warning: wrap(33, 39),
    error: wrap(31, 39)
  };
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, '0')}s`;
}

// Repository metadata and paths must not inject terminal control sequences.
function displayText(value) {
  return String(value).replace(
    // eslint-disable-next-line no-control-regex -- These characters can control the terminal.
    /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export { createCliStyle, displayText, formatElapsed };
