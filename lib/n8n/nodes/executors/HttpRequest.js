import { resolveValue } from './resolve.js'
import cds from '@sap/cds'

const log = cds.log('n8n:httpRequest')

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  const output = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const result = await executeOne(params, item, i, nodeOutputs)
    output.push(result)
  }
  return [output]
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function executeOne(params, item, itemIndex, nodeOutputs) {
  const rv = (val) => resolveValue(val, item, nodeOutputs)

  const method = (rv(params.method) ?? 'GET').toUpperCase()
  let url = String(rv(params.url) ?? '')
  url = url.trim()

  if (!url) throw new Error(`HttpRequest node: URL parameter cannot be empty`)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`HttpRequest node: Invalid URL "${url}". Must start with http:// or https://`)
  }

  // ── Query parameters ──────────────────────────────────────────────────────
  const sendQuery = params.sendQuery ?? false
  if (sendQuery) {
    const qs = new URLSearchParams()
    const specifyQuery = params.specifyQuery ?? 'keypair'

    if (specifyQuery === 'json') {
      // jsonQuery holds an object or JSON string
      const raw = rv(params.jsonQuery)
      const obj = typeof raw === 'string' ? tryParseJson(raw) : raw
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          qs.append(k, v == null ? '' : String(v))
        }
      }
    } else {
      // keypair
      for (const { name, value } of params.queryParameters?.parameters ?? []) {
        const k = rv(name)
        if (k) qs.append(k, rv(value) ?? '')
      }
    }

    const qstr = qs.toString()
    if (qstr) {
      const sep = url.includes('?') ? '&' : '?'
      url = `${url}${sep}${qstr}`
    }
  }

  // ── Headers ───────────────────────────────────────────────────────────────
  const headers = {}
  const sendHeaders = params.sendHeaders ?? false
  if (sendHeaders) {
    const specifyHeaders = params.specifyHeaders ?? 'keypair'
    if (specifyHeaders === 'json') {
      const raw = rv(params.jsonHeaders)
      const obj = typeof raw === 'string' ? tryParseJson(raw) : raw
      if (obj && typeof obj === 'object') {
        Object.assign(headers, obj)
      }
    } else {
      for (const { name, value } of params.headerParameters?.parameters ?? []) {
        const k = rv(name)
        if (k) headers[k] = rv(value) ?? ''
      }
    }
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  const sendBody = params.sendBody ?? false
  let body
  if (sendBody) {
    body = buildBody(params, rv, headers)
  }

  // ── Options ───────────────────────────────────────────────────────────────
  const opts = params.options ?? {}
  const timeoutMs = opts.timeout ?? 30000
  const ignoreResponseCode = opts.ignoreResponseCode ?? false

  // redirect: follow (default) or doNotFollow
  const redirect = opts.redirect?.redirect ?? {}
  const followRedirects = redirect.followRedirects !== false   // default true

  const responseOpts = opts.response?.response ?? {}
  const fullResponse = responseOpts.fullResponse ?? false
  let responseFormat = responseOpts.responseFormat ?? 'autodetect'

  log.debug(`${method} ${url}`)

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: followRedirects ? 'follow' : 'manual',
    })
  } catch (err) {
    throw new Error(`HttpRequest network error for ${method} ${url}: ${err.message}`)
  }

  if (response.status >= 400 && !ignoreResponseCode) {
    const text = await response.text().catch(() => '')
    throw new Error(`HttpRequest failed: ${response.status} ${response.statusText} — ${text}`)
  }

  // Autodetect response format from content-type
  if (responseFormat === 'autodetect') {
    const ct = response.headers.get('content-type') ?? ''
    if (ct.includes('json')) {
      responseFormat = 'json'
    } else if (ct.startsWith('text/')) {
      responseFormat = 'text'
    } else {
      responseFormat = 'text'
    }
  }

  const responseBody = await parseResponse(response, responseFormat)

  if (fullResponse) {
    const respHeaders = {}
    response.headers.forEach((v, k) => { respHeaders[k] = v })
    return {
      json: {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: respHeaders,
        body: responseBody,
      },
      pairedItem: { item: itemIndex },
    }
  }

  return { json: typeof responseBody === 'object' && responseBody !== null ? responseBody : { response: responseBody }, pairedItem: { item: itemIndex } }
}

function buildBody(params, rv, headers) {
  const contentType = params.contentType ?? 'json'
  const specifyBody = params.specifyBody ?? 'keypair'

  if (contentType === 'json') {
    headers['content-type'] ??= 'application/json'

    if (specifyBody === 'json') {
      const raw = rv(params.jsonBody)
      if (raw === undefined || raw === null) return undefined
      return typeof raw === 'string' ? raw : JSON.stringify(raw)
    }
    // keypair → build object
    const obj = {}
    for (const { name, value } of params.bodyParameters?.parameters ?? []) {
      const k = rv(name)
      if (k) obj[k] = rv(value) ?? ''
    }
    return JSON.stringify(obj)
  }

  if (contentType === 'raw' || contentType === 'binaryData') {
    const raw = rv(params.body)
    return raw === undefined ? undefined : String(raw)
  }

  if (contentType === 'form-urlencoded' || contentType === 'form') {
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
    const qs = new URLSearchParams()
    if (specifyBody === 'json') {
      const raw = rv(params.jsonBody)
      const obj = typeof raw === 'string' ? tryParseJson(raw) : raw
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) qs.append(k, v == null ? '' : String(v))
      }
    } else {
      for (const { name, value } of params.bodyParameters?.parameters ?? []) {
        const k = rv(name)
        if (k) qs.append(k, rv(value) ?? '')
      }
    }
    return qs.toString()
  }

  if (contentType === 'multipart-form-data' || contentType === 'multipart') {
    const fd = new FormData()
    for (const { name, value } of params.bodyParameters?.parameters ?? []) {
      const k = rv(name)
      if (k) fd.append(k, rv(value) ?? '')
    }
    return fd
  }

  return undefined
}

async function parseResponse(response, responseFormat) {
  if (responseFormat === 'json') {
    const text = await response.text()
    if (!text || !text.trim()) return {}
    try { return JSON.parse(text) } catch { return { _raw: text } }
  }
  // text, file, buffer → return as text
  return response.text()
}

function tryParseJson(str) {
  try { return JSON.parse(str) } catch { return null }
}
