/**
 * NoOp.js — n8n-nodes-base.noOp executor
 *
 * The No-op node passes all items through unchanged.
 * Used as a placeholder or to terminate a branch cleanly.
 *
 * Output ports: 1 (main)
 */

/**
 * @param {object} node   - { id, name, type, parameters, ... }
 * @param {Array}  input  - Array of items [{ json: {...} }, ...]
 * @param {object} _context
 * @returns {Array[]} Array of output port arrays
 */
export function execute(_node, input, _context) {
  const items = Array.isArray(input) ? input : (input ? [{ json: input }] : [])
  return [items]
}
