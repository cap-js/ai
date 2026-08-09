/**
 * Loop.js — n8n-nodes-base.loop executor  (alias: loopOverItems)
 *
 * The Loop node is essentially an alias for SplitInBatches with batchSize=1.
 * It passes items to a "loop" output port one at a time, and fires the "done"
 * output port once all items have been processed.
 *
 * In the n8n canvas this is the node that appears when users drag a "Loop"
 * from the palette; at the schema level it may be represented as either
 * "n8n-nodes-base.splitInBatches" or "n8n-nodes-base.loop".
 *
 * Output ports: 2
 *   Port 0 — "done"
 *   Port 1 — "loop"
 *
 * Implementation delegates entirely to SplitInBatches.
 */

export { execute } from './SplitInBatches.js'
