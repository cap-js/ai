/**
 * IntervalTrigger.js — n8n-nodes-base.interval executor (legacy Interval node)
 *
 * When executed manually/programmatically, emits a single item with timestamp.
 * Scheduling is handled by N8nService._startScheduler().
 */

export function execute(_node, _input, _context) {
  return [[{ json: { timestamp: new Date().toISOString() } }]]
}

/**
 * Convert an Interval node's parameters to milliseconds.
 *
 * @param {object} params  - node.parameters { interval, unit }
 * @returns {number}  milliseconds between firings
 */
export function toMilliseconds(params) {
  const n    = params?.interval ?? 1
  const unit = params?.unit ?? 'seconds'
  switch (unit) {
    case 'seconds': return n * 1000
    case 'minutes': return n * 60 * 1000
    case 'hours':   return n * 60 * 60 * 1000
    default:        return n * 1000
  }
}
