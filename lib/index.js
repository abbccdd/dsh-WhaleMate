/**
 * dsh-pond · 宿主侧插件入口（薄胶水）
 *
 * 职责：
 *   ① 打开共享鱼塘（~/.dsh/pond/pond.json），首次自动初始化 + 生成 owner 令牌
 *   ② 注册 DSH agent 工具 `pond`（跨渠道读写鱼塘）
 *   ③ 把 HTTP API 挂到 DSH 的 webServer（prefix /dsh-pond/api，带回环栅栏 + 令牌 + scope）
 *   ④ 可选唤醒桥（pond.config.json 里 bridge.enabled=true 才启动）
 *
 * 刻意不做的事：不 import 宿主内部包（link 安装时解析不到）；不做网络出站；不碰别的插件的数据。
 */
import os from 'node:os'
import path from 'node:path'
import { Pond } from './store.mjs'
import { createPondApi } from './api.mjs'
import { makeFence, sessionControllerFor } from './host-compat.mjs'
import { createPondTool } from './tool.mjs'
import { startBridge, readBridgeConfig } from './bridge.mjs'
import { observeInterestEvent, observeInterestReply } from './interests.mjs'
import { assembleOwnerContext } from './owner-context.mjs'
import { observeRecommendationEvent } from './recommendations.mjs'
import { observeExplicitPreferenceEvent, observeHypothesisContext } from './memory.mjs'
import { createSharedVideoObserver, renderSharedVideoDiary } from './shared-video-diary.mjs'
import { observeSemanticEvent } from './semantic-memory.mjs'
import { createPrivacyReviewer } from './privacy-review.mjs'
import { maintainPond } from './maintenance.mjs'
import { createAutoMemoryObserver } from './auto-memory.mjs'
import { storageStats } from './storage-stats.mjs'
import { createWhaleRoundObserver } from './whale-round-observer.mjs'

export const name = 'dsh-pond'
// 只硬依赖 tools（注册 agent 工具必需）；webServer / apiProxy 按需软取，headless 也能用。
export const inject = ['tools']

export function apply(ctx) {
  const home = process.env.POND_HOME || path.join(os.homedir(), '.dsh', 'pond')
  const log = (m) => { try { console.log(m) } catch {} }
  const warn = (m) => { try { console.warn(m) } catch {} }
  const disposers = []
  const cleanups = []

  let store
  try {
    store = Pond.open(home)
    store.init()
  } catch (e) {
    warn('[dsh-pond] 打开鱼塘失败：' + String(e?.message ?? e))
    return
  }

  const maintain = () => {
    try { maintainPond(store) } catch { warn('[dsh-pond] 定期整理未完成，原始数据已保留') }
    try {
      const stats = storageStats({ pondHome: store.home })
      if (stats.sessionsAboveThreshold) warn(`[dsh-pond] DSH 已压缩会话占用 ${Math.round(stats.sessions.bytes / 1048576)} MB；请用 node tools/storage.mjs status 查看。不会自动删除会话。`)
    } catch { warn('[dsh-pond] 存储统计未完成，原始数据已保留') }
  }
  maintain()
  const maintenanceTimer = setInterval(maintain, 24 * 60 * 60 * 1000)
  maintenanceTimer.unref()
  cleanups.push({stop() { clearInterval(maintenanceTimer) }})

  // ── ① agent 工具 ────────────────────────────────────────────────────────────
  try {
    const tools = ctx.get?.('tools') ?? ctx.tools
    if (tools?.register) {
      disposers.push(tools.register(createPondTool(store)))
      log('[dsh-pond] 已注册工具 pond（ingest / next / ack / list / command / kv / seen / stats）')
    } else {
      warn('[dsh-pond] tools 服务不可用，跳过工具注册（CLI 与 HTTP 仍可用）')
    }
  } catch (e) {
    warn('[dsh-pond] 工具注册失败：' + String(e?.message ?? e).slice(0, 200))
  }

  let reviewLlm = null
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['llm'], scoped => { reviewLlm = scoped?.get?.('llm') ?? scoped?.llm ?? null; return () => { reviewLlm = null } }) }
    catch { warn('[dsh-pond] 隐私分类服务不可用；共享线索将保持关闭') }
  } else {
    try { reviewLlm = ctx.get?.('llm') ?? ctx.llm ?? null } catch { /* Optional service, review fails closed. */ }
  }
  if (typeof ctx.on === 'function') {
    const observeSharedVideo = createSharedVideoObserver(store)
    const privacyReviewer = createPrivacyReviewer(store, () => reviewLlm)
    const autoMemory = createAutoMemoryObserver(store, () => reviewLlm)
    const whaleRound = createWhaleRoundObserver(store)
    cleanups.push(privacyReviewer)
    cleanups.push(autoMemory)
    cleanups.push(whaleRound)
    try { renderSharedVideoDiary(store) } catch { warn('[dsh-pond] 私聊分享日记无法生成') }
    disposers.push(ctx.on('session/event', (session, event) => {
      try { whaleRound.observe(session,event) }
      catch { warn('[dsh-pond] 刷站完成记录失败；未触发主动分享') }
      try { observeSemanticEvent(store, session, event) }
      catch { warn('[dsh-pond] 私人兴趣上下文观察失败') }
      try { observeInterestEvent(store, session, event) }
      catch { warn('[dsh-pond] 兴趣观察失败；未记录聊天正文') }
      try { observeInterestReply(store, session, event) }
      catch { warn('[dsh-pond] 兴趣推荐冷却记录失败；未记录聊天正文') }
      try { observeExplicitPreferenceEvent(store, session, event) }
      catch { warn('[dsh-pond] 类别偏好观察失败；未记录聊天正文') }
      try { observeHypothesisContext(store, session, event) }
      catch { warn('[dsh-pond] 记忆上下文观察失败；未记录聊天正文') }
      try { observeRecommendationEvent(store, session, event) }
      catch { warn('[dsh-pond] 分享反馈观察失败；未记录聊天正文') }
      try { observeSharedVideo(session, event) }
      catch { warn('[dsh-pond] 分享日记记录失败；未记录聊天正文') }
      void privacyReviewer.observe(session, event).catch(() => warn('[dsh-pond] 隐私分类未完成；不共享该线索'))
      void autoMemory.observe(session, event).catch(() => warn('[dsh-pond] 自动记忆提取失败；未保存消息正文'))
    }))
    disposers.push(ctx.on('system-prompt/assemble', (_assembly, context, next) => assembleOwnerContext(store, context, next, warn), { global: true }))
  }

  // ── ② HTTP API（webServer 就绪后挂载；没有 webServer 的平台自然跳过）─────────
  const mountApi = (wc) => {
    try {
      const ws = wc?.webServer ?? wc?.get?.('webServer')
      if (!ws?.register) return
      const api = createPondApi({ store, fence: makeFence(ctx) })
      disposers.push(ws.register({
        kind: 'prefix',
        path: api.prefix,
        handler: (req, res) => api.handle(req, res),
      }))
      log(`[dsh-pond] API 已挂载：${api.prefix}（回环 + 令牌 + scope + 审计）`)
    } catch (e) {
      warn('[dsh-pond] API 挂载失败：' + String(e?.message ?? e).slice(0, 200))
    }
  }
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['webServer'], mountApi) } catch { mountApi() }
  } else {
    mountApi()
  }

  // ── ③ 可选唤醒桥（默认关；读了配置才启动）──────────────────────────────────
  try {
    const cfg = readBridgeConfig(home)
    if (cfg.enabled) {
      cleanups.push(startBridge({ store, controller: sessionControllerFor(ctx), home, log }))
      log(`[dsh-pond] 唤醒桥已启动：session=${cfg.sessionId}（actions=${cfg.actions.join(',')}）`)
    }
  } catch (e) {
    warn('[dsh-pond] 唤醒桥未启动：' + String(e?.message ?? e).slice(0, 200))
  }

  // ── 卸载清理 ────────────────────────────────────────────────────────────────
  const disposeAll = () => {
    for (const c of cleanups) { try { c?.stop?.() } catch {} }
    for (const d of disposers) { try { d() } catch {} }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => disposeAll())
  } catch { /* cordis effect 不可用时忽略（进程退出自然释放） */ }

  log(`[dsh-pond] 就绪 · ${home} · 渠道 ${store.channelList().length} 个`)
}
