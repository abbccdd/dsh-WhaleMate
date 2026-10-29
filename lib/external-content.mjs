/** Suppress obvious prompt injections in public snippets; remaining content is still untrusted. */
export function publicSnippetAllowed(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu,'')
  if (!s || s.length > 1000) return false
  return !/(?:忽略|无视|忘掉|覆盖|绕过|突破).{0,25}(?:规则|指令|提示|限制|安全|权限|之前|上面|系统)|(?:系统|开发者|管理员|主人|用户).{0,12}(?:指令|命令|提示词)|(?:密码|口令|验证码|私聊|秘密|令牌|凭据|密钥|住址|手机号|家庭地址)|(?:system|developer|assistant)\s*[:：]|(?:ignore|disregard|reveal|exfiltrate).{0,25}(?:instruction|prompt|secret|password|token)|(?:https?:\/\/|www\.)/iu.test(s)
}
