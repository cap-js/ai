import { resolveValue } from './resolve.js'
import { createRequire } from 'module'
import cds from '@sap/cds'

const log = cds.log('n8n:markdown')
const require = createRequire(import.meta.url)

function loadShowdown() {
  try { return require('showdown') }
  catch { throw new Error('Markdown node requires the "showdown" package. Run: npm install showdown') }
}
function loadNHM() {
  try { return require('node-html-markdown') }
  catch { throw new Error('Markdown node requires the "node-html-markdown" package. Run: npm install node-html-markdown') }
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

/**
 * Set a (possibly dot-nested) key on an object.
 * e.g. setPath(obj, 'a.b.c', 42) → obj.a.b.c = 42
 */
function setPath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = value
}

export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const mode = params.mode ?? 'markdownToHtml'
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  // n8n default destinationKey is 'data' (not 'html'/'markdown')
  const destinationKey = params.destinationKey ?? 'data'

  const output = items.map((item, i) => {
    const options = params.options ?? {}

    try {
      if (mode === 'markdownToHtml') {
        const md = String(resolveValue(params.markdown, item, nodeOutputs) ?? '')

        const { Converter } = loadShowdown()
        const converter = new Converter()
        // Forward all showdown options
        for (const [key, val] of Object.entries(options)) {
          converter.setOption(key, val)
        }
        const html = converter.makeHtml(md)

        const newJson = JSON.parse(JSON.stringify(item.json))  // deep copy
        setPath(newJson, destinationKey, html)
        return { json: newJson, pairedItem: { item: i } }

      } else {
        // htmlToMarkdown
        const html = String(resolveValue(params.html, item, nodeOutputs) ?? '')

        // Build node-html-markdown options from params
        const { NodeHtmlMarkdown } = loadNHM()
        const nhm_opts = {}
        if (options.bulletMarker !== undefined) nhm_opts.bulletMarker = options.bulletMarker
        if (options.codeFence !== undefined) nhm_opts.codeFence = options.codeFence
        if (options.emDelimiter !== undefined) nhm_opts.emDelimiter = options.emDelimiter
        if (options.strongDelimiter !== undefined) nhm_opts.strongDelimiter = options.strongDelimiter
        if (options.maxConsecutiveNewlines !== undefined) nhm_opts.maxConsecutiveNewlines = options.maxConsecutiveNewlines
        if (options.useLinkReferenceDefinitions !== undefined) nhm_opts.useLinkReferenceDefinitions = options.useLinkReferenceDefinitions
        if (options.keepDataImages !== undefined) nhm_opts.keepDataImages = options.keepDataImages
        if (options.codeBlockStyle !== undefined) nhm_opts.codeBlockStyle = options.codeBlockStyle

        if (options.ignore) {
          nhm_opts.ignore = options.ignore.split(',').map(s => s.trim()).filter(Boolean)
        }
        if (options.blockElements) {
          nhm_opts.blockElements = options.blockElements.split(',').map(s => s.trim()).filter(Boolean)
        }

        // textReplace: array of {pattern, replacement}
        if (options.textReplace?.values?.length) {
          nhm_opts.textReplace = options.textReplace.values.map(e => [e.pattern, e.replacement])
        }
        // lineStartEscape: {value: {pattern, replacement}}
        const lse = options.lineStartEscape?.value
        if (lse?.pattern) nhm_opts.lineStartEscape = [lse.pattern, lse.replacement ?? '']
        // globalEscape: {value: {pattern, replacement}}
        const ge = options.globalEscape?.value
        if (ge?.pattern) nhm_opts.globalEscape = [ge.pattern, ge.replacement ?? '']

        const markdown = NodeHtmlMarkdown.translate(html, nhm_opts)

        const newJson = JSON.parse(JSON.stringify(item.json))
        setPath(newJson, destinationKey, markdown)
        return { json: newJson, pairedItem: { item: i } }
      }
    } catch (err) {
      log.warn(`Markdown node error on item ${i}:`, err.message)
      return { json: { ...item.json, error: err.message }, pairedItem: { item: i } }
    }
  })

  return [output]
}
