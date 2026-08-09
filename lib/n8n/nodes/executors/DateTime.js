/**
 * DateTime.js — n8n-nodes-base.dateTime executor (V2 conformant)
 *
 * Operations (V2 names):
 *   getCurrentDate      — current date/time, optionally truncated to midnight
 *   addToDate           — add duration to a date  (param: magnitude, timeUnit, duration)
 *   subtractFromDate    — subtract duration from a date
 *   formatDate          — reformat a date to a preset or custom luxon-token format
 *   getTimeBetweenDates — diff two dates in one or more units (returns object)
 *   roundDate           — floor/ceil a date to a unit boundary
 *   extractDate         — extract a single calendar part (year/month/week/day/hour/minute/second)
 *
 * All operations support `options.includeInputFields` to carry through input fields.
 *
 * Format tokens implemented (subset of luxon used by n8n V2):
 *   MM/dd/yyyy  YYYY/MM/DD  MMMM dd yyyy  MM-dd-yyyy  yyyy-MM-dd
 *   X (unix seconds)  x (unix ms)  custom (arbitrary token string)
 *
 * No luxon/moment dependency — uses native JS Date.
 */

import { resolveValue } from './resolve.js'

export function execute(node, input, context) {
  const params = node.parameters ?? {}
  const items = normaliseInput(input)
  const operation = params.operation ?? 'getCurrentDate'
  const includeInputFields = params.options?.includeInputFields ?? false

  const output = items.map((item, i) => {
    const base = includeInputFields ? { ...item.json } : {}
    try {
      const result = applyOperation(operation, params, item, context)
      return { json: { ...base, ...result } }
    } catch (err) {
      // continueOnFail equivalent — emit error field
      return { json: { ...base, error: err.message } }
    }
  })

  return [output]
}

// ── Operation dispatcher ────────────────────────────────────────────────────

function applyOperation(operation, params, item, context) {
  switch (operation) {
    case 'getCurrentDate':
      return opGetCurrentDate(params, item, context)

    case 'addToDate':
      return opAddSubtract(params, item, context, 1)

    case 'subtractFromDate':
      return opAddSubtract(params, item, context, -1)

    case 'formatDate':
      return opFormatDate(params, item, context)

    case 'getTimeBetweenDates':
      return opGetTimeBetween(params, item, context)

    case 'roundDate':
      return opRoundDate(params, item, context)

    case 'extractDate':
      return opExtractDate(params, item, context)

    // Legacy V1 operation aliases (keep working if anyone uses old names)
    case 'format':
      return opFormatDate({ ...params, date: params.value }, item, context)

    case 'addTo':
      return opAddSubtract({ ...params, magnitude: params.value }, item, context, 1)

    case 'subtractFrom':
      return opAddSubtract({ ...params, magnitude: params.value }, item, context, -1)

    case 'now':
    case 'currentDate':
      return opGetCurrentDate(params, item, context)

    case 'extractPart':
      return opExtractDate({ ...params, date: params.value, part: params.datePart }, item, context)

    case 'dateDiff': {
      // V1 compat
      const d1 = parseDate(resolveValue(params.date1, item, context?.nodeOutputs))
      const d2 = parseDate(resolveValue(params.date2, item, context?.nodeOutputs))
      const unit = params.timeUnit ?? 'days'
      const fieldName = params.outputFieldName ?? 'dateDiff'
      const diff = diffMs(d2 - d1, unit)
      return { [fieldName]: diff }
    }

    default:
      throw new Error(`DateTime: unknown operation "${operation}"`)
  }
}

// ── getCurrentDate ──────────────────────────────────────────────────────────

function opGetCurrentDate(params, item, context) {
  const includeTime = params.includeTime ?? true
  const outputFieldName = params.outputFieldName ?? 'currentDate'
  const tz = params.options?.timezone ?? null

  let d = new Date()
  if (!includeTime) {
    // Truncate to start of day
    d = startOfDay(d, tz)
  }

  return { [outputFieldName]: formatForOutput(d, tz) }
}

// ── addToDate / subtractFromDate ────────────────────────────────────────────

function opAddSubtract(params, item, context, sign) {
  const rawDate = resolveValue(params.magnitude, item, context?.nodeOutputs)
  const timeUnit = params.timeUnit ?? 'days'
  const duration = Number(resolveValue(params.duration, item, context?.nodeOutputs) ?? 0)
  const outputFieldName = params.outputFieldName ?? 'newDate'

  const d = parseDate(rawDate)
  adjustDate(d, timeUnit, sign * duration)
  return { [outputFieldName]: d.toISOString() }
}

// ── formatDate ──────────────────────────────────────────────────────────────

function opFormatDate(params, item, context) {
  const rawDate = resolveValue(params.date, item, context?.nodeOutputs)
  const format = params.format ?? 'MM/dd/yyyy'
  const outputFieldName = params.outputFieldName ?? 'formattedDate'

  if (rawDate === null || rawDate === undefined) {
    return { [outputFieldName]: rawDate }
  }

  const d = parseDate(rawDate)

  let formatted
  if (format === 'custom') {
    const customFormat = params.customFormat ?? ''
    formatted = applyLuxonFormat(d, customFormat)
  } else {
    formatted = applyLuxonFormat(d, format)
  }

  return { [outputFieldName]: formatted }
}

// ── getTimeBetweenDates ─────────────────────────────────────────────────────

function opGetTimeBetween(params, item, context) {
  const rawStart = resolveValue(params.startDate, item, context?.nodeOutputs)
  const rawEnd = resolveValue(params.endDate, item, context?.nodeOutputs)
  const outputFieldName = params.outputFieldName ?? 'timeDifference'
  const isoString = params.options?.isoString ?? false

  const d1 = parseDate(rawStart)
  const d2 = parseDate(rawEnd)

  // units is a multiOptions — may be array or comma-string
  let units = params.units ?? ['day']
  if (typeof units === 'string') units = units.split(',').map(u => u.trim())
  if (!Array.isArray(units)) units = [units]

  if (isoString) {
    // Return ISO duration string like "P1Y2M3DT4H5M6S"
    const msTotal = d2.getTime() - d1.getTime()
    return { [outputFieldName]: msToIsoDuration(msTotal) }
  }

  // Return object: { day: 5, hour: 2, ... } (each unit independently)
  const result = {}
  const msTotal = d2.getTime() - d1.getTime()
  for (const unit of units) {
    result[unit] = diffMs(msTotal, unit)
  }
  return { [outputFieldName]: result }
}

// ── roundDate ───────────────────────────────────────────────────────────────

function opRoundDate(params, item, context) {
  const rawDate = resolveValue(params.date, item, context?.nodeOutputs)
  const mode = params.mode ?? 'roundDown'
  const outputFieldName = params.outputFieldName ?? 'roundedDate'

  const d = parseDate(rawDate)

  if (mode === 'roundDown') {
    const toNearest = params.toNearest ?? 'month'
    const rounded = floorDate(d, toNearest)
    return { [outputFieldName]: rounded.toISOString() }
  } else if (mode === 'roundUp') {
    // n8n V2 only supports "end of month" for round-up
    const to = params.to ?? 'month'
    const rounded = ceilDate(d, to)
    return { [outputFieldName]: rounded.toISOString() }
  }

  return { [outputFieldName]: d.toISOString() }
}

// ── extractDate ─────────────────────────────────────────────────────────────

function opExtractDate(params, item, context) {
  const rawDate = resolveValue(params.date, item, context?.nodeOutputs)
  const part = params.part ?? 'month'
  const outputFieldName = params.outputFieldName ?? 'datePart'

  const d = parseDate(rawDate)
  const value = extractPart(d, part)
  return { [outputFieldName]: value }
}

// ── Date parsing ────────────────────────────────────────────────────────────

/**
 * Parse a date value: ISO string, numeric timestamp (seconds or ms), or Date.
 */
function parseDate(val) {
  if (val instanceof Date) return new Date(val)

  if (typeof val === 'number' || (typeof val === 'string' && !isNaN(Number(val)) && val.trim() !== '')) {
    const num = Number(val)
    // n8n heuristic: if < 12 digits, treat as seconds
    if (num.toString().length < 12) {
      return new Date(num * 1000)
    }
    return new Date(num)
  }

  const d = new Date(val)
  if (isNaN(d.getTime())) throw new Error(`Invalid date: "${val}"`)
  return d
}

// ── Date arithmetic ─────────────────────────────────────────────────────────

function adjustDate(d, unit, amount) {
  switch (unit) {
    case 'milliseconds': d.setMilliseconds(d.getMilliseconds() + amount); break
    case 'seconds':      d.setSeconds(d.getSeconds() + amount); break
    case 'minutes':      d.setMinutes(d.getMinutes() + amount); break
    case 'hours':        d.setHours(d.getHours() + amount); break
    case 'days':         d.setDate(d.getDate() + amount); break
    case 'weeks':        d.setDate(d.getDate() + amount * 7); break
    case 'months':       d.setMonth(d.getMonth() + amount); break
    case 'quarters':     d.setMonth(d.getMonth() + amount * 3); break
    case 'years':        d.setFullYear(d.getFullYear() + amount); break
  }
}

// ── Diff ────────────────────────────────────────────────────────────────────

function diffMs(ms, unit) {
  // n8n V2 uses singular unit names for getTimeBetweenDates
  switch (unit) {
    case 'millisecond': case 'milliseconds': return ms
    case 'second':  case 'seconds':  return Math.trunc(ms / 1000)
    case 'minute':  case 'minutes':  return Math.trunc(ms / 60000)
    case 'hour':    case 'hours':    return Math.trunc(ms / 3600000)
    case 'day':     case 'days':     return Math.trunc(ms / 86400000)
    case 'week':    case 'weeks':    return Math.trunc(ms / 604800000)
    // month/year: approximate
    case 'month':   case 'months':   return Math.trunc(ms / (86400000 * 30.4375))
    case 'year':    case 'years':    return Math.trunc(ms / (86400000 * 365.25))
    default: return ms
  }
}

function msToIsoDuration(ms) {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  const s = Math.floor(abs / 1000)
  const years = Math.floor(s / 31557600)
  const rem1 = s % 31557600
  const months = Math.floor(rem1 / 2629800)
  const rem2 = rem1 % 2629800
  const days = Math.floor(rem2 / 86400)
  const rem3 = rem2 % 86400
  const hours = Math.floor(rem3 / 3600)
  const rem4 = rem3 % 3600
  const minutes = Math.floor(rem4 / 60)
  const seconds = rem4 % 60
  let str = `${sign}P`
  if (years) str += `${years}Y`
  if (months) str += `${months}M`
  if (days) str += `${days}D`
  if (hours || minutes || seconds) {
    str += 'T'
    if (hours) str += `${hours}H`
    if (minutes) str += `${minutes}M`
    if (seconds) str += `${seconds}S`
  }
  if (str === 'P' || str === '-P') str += 'T0S'
  return str
}

// ── Floor / Ceil ────────────────────────────────────────────────────────────

function floorDate(d, unit) {
  const r = new Date(d)
  switch (unit) {
    case 'year':   r.setMonth(0, 1); r.setHours(0, 0, 0, 0); break
    case 'month':  r.setDate(1); r.setHours(0, 0, 0, 0); break
    case 'week': {
      // Start of ISO week (Monday)
      const day = r.getDay() || 7
      r.setDate(r.getDate() - day + 1)
      r.setHours(0, 0, 0, 0)
      break
    }
    case 'day':    r.setHours(0, 0, 0, 0); break
    case 'hour':   r.setMinutes(0, 0, 0); break
    case 'minute': r.setSeconds(0, 0); break
    case 'second': r.setMilliseconds(0); break
  }
  return r
}

function ceilDate(d, unit) {
  // n8n V2 only offers "end of month" (roundUp → to: 'month')
  // meaning: go to next month start, then subtract 1ms — or just use end-of-month
  const r = new Date(d)
  switch (unit) {
    case 'month': {
      // Start of next month
      r.setMonth(r.getMonth() + 1, 1)
      r.setHours(0, 0, 0, 0)
      break
    }
    default: {
      // Generic: floor of (d + 1 unit)
      adjustDate(r, unit, 1)
      return floorDate(r, unit)
    }
  }
  return r
}

// ── Extract part ────────────────────────────────────────────────────────────

function extractPart(d, part) {
  switch (part) {
    case 'year':   return d.getFullYear()
    case 'month':  return d.getMonth() + 1
    case 'week':   return isoWeekNumber(d)
    case 'day':    return d.getDate()
    case 'hour':   return d.getHours()
    case 'minute': return d.getMinutes()
    case 'second': return d.getSeconds()
    default:       return undefined
  }
}

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  // ISO: week starts Monday; Jan 4 is always in week 1
  const dayOfWeek = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
}

// ── Luxon-token formatting (native JS, no luxon dependency) ─────────────────
//
// Supported preset tokens (as defined in n8n V2 FormatDateDescription):
//   MM/dd/yyyy   →  09/04/1986
//   yyyy/MM/dd   →  1986/04/09
//   MMMM dd yyyy →  April 09 1986
//   MM-dd-yyyy   →  09-04-1986
//   yyyy-MM-dd   →  1986-04-09
//   X            →  unix seconds (string)
//   x            →  unix ms (string)
//
// Custom format: a string with luxon tokens — we implement the common ones.

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
]
const MONTH_SHORT = MONTH_NAMES.map(m => m.slice(0, 3))

function pad(n, len = 2) { return String(n).padStart(len, '0') }

function applyLuxonFormat(d, fmt) {
  // Unix shortcuts
  if (fmt === 'X') return String(Math.floor(d.getTime() / 1000))
  if (fmt === 'x') return String(d.getTime())

  // Replace longest tokens first (order matters)
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/yy/g, String(d.getFullYear()).slice(-2))
    .replace(/MMMM/g, MONTH_NAMES[d.getMonth()])
    .replace(/MMM/g, MONTH_SHORT[d.getMonth()])
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/M/g, String(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/d/g, String(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/H/g, String(d.getHours()))
    .replace(/hh/g, pad(d.getHours() % 12 || 12))
    .replace(/h/g, String(d.getHours() % 12 || 12))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()))
    .replace(/SSS/g, pad(d.getMilliseconds(), 3))
    .replace(/a/g, d.getHours() < 12 ? 'AM' : 'PM')
    .replace(/Z/g, tzOffset(d))
    .replace(/z/g, 'UTC')
}

function tzOffset(d) {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// ── Timezone helpers (simplified — no IANA tz support without libraries) ────

function startOfDay(d, _tz) {
  // Without a real tz library we ignore the tz param and use local time
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

function formatForOutput(d, _tz) {
  return d.toISOString()
}

// ── Input normalisation ─────────────────────────────────────────────────────

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}
