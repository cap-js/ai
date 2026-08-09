/**
 * ManualTrigger.js — n8n-nodes-base.manualTrigger executor
 *
 * The Manual Trigger node is the workflow entry point when triggered manually.
 * It produces a single empty item if no input is provided, otherwise passes
 * input through unchanged.
 *
 * Output ports: 1 (main)
 */

/**
 * @param {object} node   - { id, name, type, parameters, ... }
 * @param {Array}  input  - Array of items [{ json: {...} }, ...]
 * @param {object} context - { cds, executionId, workflowId }
 * @returns {Array[]} Array of output port arrays
 */
export function execute(node, input, _context) {
  const items = Array.isArray(input) ? input : (input ? [{ json: input }] : [])
  // If no items were provided, emit a single empty item so downstream nodes run
  if (items.length === 0) {
    return [[{ json: {} }]]
  }
  return [items]
}
