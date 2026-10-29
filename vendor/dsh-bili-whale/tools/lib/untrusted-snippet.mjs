/** Screening for public text displayed to the browsing model; never an authorization boundary. */
export function safePublicSnippet(value, limit = 300) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!text) return ''
  const injection = /(?:忽略|无视|忘掉|覆盖|绕过|突破).{0,30}(?:规则|指令|提示|限制|安全|权限|之前|上面|系统)|(?:系统|开发者|管理员|主人|用户).{0,12}(?:指令|命令|提示词)|(?:读取|查看|查找|复制|发送|公开|透露|上传|泄露|给我).{0,30}(?:密码|口令|验证码|私聊|聊天记录|秘密|令牌|凭据|密钥|住址|手机号|文件|日记)|(?:system|developer|assistant)\s*[:：]|(?:ignore|disregard|reveal|exfiltrate).{0,30}(?:instruction|prompt|secret|password|token)|(?:https?:\/\/|www\.)/iu
  if (injection.test(text)) return '[可疑外部内容已隐藏]'
  return text.slice(0, limit)
}
