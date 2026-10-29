import { randomUUID } from 'node:crypto'

// Keep the scheduler independent of the host's service names and RPC envelopes.
export function sessionControllerFor(ctx) {
  const legacy = ctx.get('sessionController')
  if (legacy) return legacy
  const sessions = ctx.get('apiProxy')?.sessions
  if (!sessions) throw new Error('DSH 未提供可用的会话 API；请更新养鱼插件的宿主适配器')
  async function invoke(method, payload, rpcId = randomUUID()) {
    const response = await sessions[method]({ rpcId, payload })
    if (!response.result.ok) {
      const { code, message } = response.result.error
      throw new Error(`DSH ${method} (${code}): ${message}`)
    }
    return response.result.value
  }
  return {
    create: payload => invoke('create', payload),
    prompt({ requestId, ...payload }, signal) {
      signal?.throwIfAborted()
      return invoke('prompt', payload, requestId)
    },
  }
}

// New Connection versions expose RPC registration rather than requestRejection.
// Preserve the raw HTTP settings routes' loopback and same-origin boundary.
export function requestRejectionFor(connection, req) {
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  if (typeof connection?.rpc?.handle !== 'function') return 503
  const host = req.headers.host
  if (typeof host !== 'string') return 403
  let target
  try { target = new URL(`http://${host}`) } catch { return 403 }
  if (target.host !== host.toLowerCase() || target.pathname !== '/' || target.username || target.password) return 403
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return 403
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return 403
  const origin = req.headers.origin
  if (origin !== undefined && origin !== target.origin) return 403
  return undefined
}
