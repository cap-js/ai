/**
 * Wait.js — n8n-nodes-base.wait executor
 *
 * In a real n8n deployment the Wait node suspends workflow execution until
 * a timer or webhook resumes it. In the CAP execution model we do not
 * replicate that suspension mechanism — async waiting is handled externally
 * (e.g. via CAP messaging delay or scheduled jobs).
 *
 * For v1 this executor simply passes items through so the workflow continues
 * without actually waiting. A log warning is emitted so operators know the
 * wait was skipped.
 *
 * Parameters (informational only — not acted upon):
 *   parameters.resume       — 'timeInterval' | 'specificTime' | 'webhook' | 'form'
 *   parameters.amount       — wait amount (for timeInterval)
 *   parameters.unit         — 'seconds' | 'minutes' | 'hours' | 'days'
 *   parameters.dateTime     — ISO datetime (for specificTime)
 *
 * Output ports: 1 (main)
 */

import cds from '@sap/cds'

const log = cds.log('n8n:wait')

/**
 * @param {object} node
 * @param {Array}  input
 * @param {object} _context
 * @returns {Array[]}
 */
export function execute(node, input, _context) {
  const params = node.parameters ?? {}
  const resume = params.resume ?? 'timeInterval'
  const amount = params.amount ?? ''
  const unit = params.unit ?? ''

  let waitDesc
  if (resume === 'timeInterval' && amount) {
    waitDesc = `${amount} ${unit}`
  } else if (resume === 'specificTime' && params.dateTime) {
    waitDesc = `until ${params.dateTime}`
  } else {
    waitDesc = resume
  }

  log.warn(`Wait node "${node.name}" (resume: ${waitDesc}) — async waiting is not supported in CAP execution mode; passing items through immediately`)

  const items = normaliseInput(input)
  return [items]
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}
