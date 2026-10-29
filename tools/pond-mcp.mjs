#!/usr/bin/env node
/**
 * dsh-pond · MCP stdio 服务（零依赖）
 *
 * 任何支持 MCP 的应用（DSH 的 MCP client、LangBot、AstrBot、Claude Desktop、自写脚本）
 * 都可以把「鱼塘」当成一个工具后端：stdin/stdout 上跑 JSON-RPC（换行分隔）。
 *
 * DSH 里接入：设置 → MCP → 添加 stdio 服务
 *   command: node
 *   args: ["<插件安装目录>/tools/pond-mcp.mjs"]
 *
 * 必须在进程环境 POND_TOKEN 配置渠道令牌；不接受 owner 令牌，不再隐式获得 owner。
 */
import readline from 'node:readline'
import { Pond, defaultPondHome } from '../lib/store.mjs'
import { runAction, summarize, ACTIONS } from '../lib/actions.mjs'
import { PRIVACY_PROMPT } from '../lib/privacy.mjs'
import { TOPICS, SIGNALS, RATINGS } from '../lib/memory.mjs'

const store = Pond.open(defaultPondHome())

const TOOL = {
  name: 'pond',
  description: [
    '共享鱼塘：跨应用共享的本地数据（QQ/微信转发的内容、B站 候选、待办指令、判重账本、共享 KV）。',
    'ingest 写入内容；next 取最老的待看内容与待处理指令；ack 标记已处理；',
    'command 排队"要去做的事"；commands 查看指令；kv_get/kv_set 共享状态；seen 判重；stats 总览。',
    '同一 DeepSeek 角色用 action=profile 读取共用公共人设与偏好；不覆盖明确指定的其他角色卡或平台权限。',
    '已授权会话可以读取结构化记忆、记录分类偏好及视频 BV；不要存私聊原文。',
    '仅当主人要求找做饭教程时才用 interest_recall 的 cooking 场景；遵守避免重复的列表，确实推荐后才用 interest_used，禁止对公开平台透露私聊兴趣。',
    PRIVACY_PROMPT,
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS.filter((a) => a !== 'channels') },
      kind: { type: 'string' },
      source: { type: 'string' },
      bvid: { type: 'string' },
      title: { type: 'string' },
      url: { type: 'string' },
      text: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      private: { type: 'boolean' },
      profileId: { type: 'string', enum: ['deepseek'] },
      topic: { type: 'string', enum: TOPICS },
      signal: { type: 'string', enum: SIGNALS },
      rating: { type: 'string', enum: RATINGS },
      offset: { type: 'integer', minimum: 0 },
      documentKind: { type: 'string', enum: ['report', 'diary'] },
      date: { type: 'string' },
      documentRevision: { type: 'string' },
      interestContext: { type: 'string', enum: ['cooking'] },
      interestSubject: { type: 'string' },
      dedupe: { type: 'boolean' },
      dedupeKey: { type: 'string' },
      id: { type: 'string' },
      status: { type: 'string' },
      q: { type: 'string' },
      limit: { type: 'integer' },
      commandAction: { type: 'string' },
      commandArgs: { type: 'object' },
      user: { type: 'string' },
      wake: { type: 'boolean' },
      key: { type: 'string' },
      value: {},
      meta: { type: 'object' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function messageText(value) {
  if (typeof value === 'string') return value
  try { return summarize(value) } catch { return JSON.stringify(value) }
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-pond', version: '0.6.0' },
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: [TOOL] })
      return
    case 'tools/call': {
      const name = params?.name
      if (name !== 'pond') { reply(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }); return }
      const auth = store.authenticate(process.env.POND_TOKEN)
      const result = auth?.kind === 'channel'
        ? await runAction(store, params?.arguments ?? {}, { identity: { principal: 'channel:' + auth.channel.id, scopes: auth.scopes } })
        : { ok: false, error: 'MCP 需要在 POND_TOKEN 配置有效渠道令牌；不接受 owner 令牌' }
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result.ok === false,
      })
      return
    }
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      replyError(id, -32601, `Method not found: ${method}`)
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch {
    replyError(null, -32700, 'Parse error')
    return
  }
  handle(msg).catch(e => replyError(msg?.id ?? null, -32603, String(e?.message ?? e)))
})
rl.on('close', () => { try { process.exit(0) } catch {} })
