/**
 * dsh-pond · 宿主兼容层（与 dsh-bili-whale 的 host-compat 同源思路）
 *
 * 只做两件事：
 *   ① 回环栅栏：DSH 的 Web 端口是回环地址，但浏览器里**任何网页**都能向回环发请求 ——
 *      没有栅栏 = 把共享数据开放给任意页面。这里 fail-closed：栅栏不可用就拒绝。
 *   ② 会话控制器：只有可选「唤醒桥」用得上；宿主 API 缺失时抛错而不是静默降级。
 */
import { randomUUID } from 'node:crypto'

/** 请求 Host 头是不是本机回环。 */
export function isLoopbackReq(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  try {
    const target = new URL(`http://${host}`)
    return target.host === host.toLowerCase() && target.pathname === '/' && !target.username && !target.password && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  } catch { return false }
}

/**
 * 用宿主 connection 服务的 requestRejection 做同源栅栏。
 * 新版本只有 rpc.handle 时退化为手写检查（与 whale 的兜底一致）。
 * @returns {number|null|undefined} 拒绝码；undefined = 放行
 */
export function requestRejectionFor(connection, req) {
  if (!isLoopbackReq(req)) return 403
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
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  if (typeof connection?.rpc?.handle !== 'function') return 503
  return undefined
}

/** 只在本机回环 + connection 栅栏都通过时放行。 */
export function makeFence(ctx) {
  let warned = false
  return (req) => {
    if (!isLoopbackReq(req)) return 403
    try {
      const conn = ctx.get?.('connection') || ctx.connection
      if (!conn) {
        if (!warned) {
          warned = true
          console.warn('[dsh-pond] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 拒绝')
        }
        return 503
      }
      return requestRejectionFor(conn, req)
    } catch {
      return 503
    }
  }
}

/** 宿主会话控制器（apiProxy.sessions / sessionController）。缺失即抛错，绝不静默。 */
export function sessionControllerFor(ctx) {
  const legacy = ctx.get?.('sessionController')
  if (legacy) return legacy
  const sessions = ctx.get?.('apiProxy')?.sessions
  if (!sessions) throw new Error('DSH 未提供可用的会话 API（唤醒桥需要 apiProxy.sessions）；可关掉 bridge 或更新宿主')
  async function invoke(method, payload, rpcId = randomUUID()) {
    const response = await sessions[method]({ rpcId, payload })
    if (!response.result.ok) {
      const { code, message } = response.result.error
      throw new Error(`DSH ${method} (${code}): ${message}`)
    }
    return response.result.value
  }
  return {
    create: (payload) => invoke('create', payload),
    prompt({ requestId, ...payload }, signal) {
      signal?.throwIfAborted()
      return invoke('prompt', payload, requestId)
    },
  }
}
