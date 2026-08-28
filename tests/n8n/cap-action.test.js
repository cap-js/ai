import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'
import { runWorkflow, firstItem, allItems } from '../helpers/n8n.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { GET, POST } = cds.test(path.join(__dirname, '../bookshop'))

describe('capAction workflows', () => {
  test('wf-place-order: successful order reduces stock', async () => {
    const { status, runData, error } = await runWorkflow('wf-place-order', { book: 201, quantity: 1 }, { GET, POST })
    assert.equal(status, 'success', `execution failed: ${error?.message ?? JSON.stringify(error)}`)
    const item = firstItem(runData, 'OrderResult')
    assert.ok(item, 'OrderResult node produced no output')
    assert.equal(item.book, 201)
    assert.equal(item.quantity, 1)
    assert.equal(item.status, 'ordered')
    assert.ok(typeof item.remainingStock === 'number')
  })

  test('wf-place-order: insufficient stock routes to StopAndError', async () => {
    const { status } = await runWorkflow('wf-place-order', { book: 201, quantity: 999999 }, { GET, POST })
    assert.equal(status, 'error')
  })

  test('wf-place-order: SubmitOrder node has non-empty output', async () => {
    const { status, runData, error } = await runWorkflow('wf-place-order', { book: 201, quantity: 1 }, { GET, POST })
    assert.equal(status, 'success', `execution failed: ${error?.message ?? JSON.stringify(error)}`)
    const submitItems = allItems(runData, 'SubmitOrder')
    assert.ok(submitItems.length > 0, 'SubmitOrder produced no items — capAction params broken')
    assert.ok(typeof submitItems[0].json.stock === 'number', 'stock field missing from SubmitOrder output')
  })
})
