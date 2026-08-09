'use strict'
/**
 * N8nAdapter — CAP protocol adapter for the n8n REST API.
 *
 * This adapter is registered via cds.service.protocols['n8n'] in cds-plugin.js.
 * It handles only the REST API routes mounted under the service path (e.g. /n8n).
 *
 * Static file serving, /healthz, and the SPA fallback are mounted separately
 * in cds.on('bootstrap') via mountN8nStatic() — those need app-level registration
 * and must come after the API router to avoid catching REST requests.
 */

let _buildN8nRouter // injected from ESM world by N8nAdapter.inject()

class N8nAdapter {
  constructor(srv, conf) {
    this.service = srv
    this.conf    = conf || {}
  }

  get router() {
    if (!_buildN8nRouter) {
      throw new Error('[n8n] N8nAdapter used before buildN8nRouter was injected. ' +
        'Make sure cds-plugin.js calls N8nAdapter.inject(buildN8nRouter).')
    }
    const { router } = _buildN8nRouter(this.conf)
    return Object.defineProperty(this, 'router', { value: router }).router
  }

  /** Called by cds-plugin.js once buildN8nRouter is available from ESM world. */
  static inject(fn) {
    _buildN8nRouter = fn
  }
}

module.exports = N8nAdapter
