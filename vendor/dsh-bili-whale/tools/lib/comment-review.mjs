import { createHash } from 'node:crypto'

// 绑定实际内容和目标，防止审核后意外发出另一条。此标记是流程保护，
// 不是同一 Windows 用户下对抗恶意程序的安全边界。
export function reviewDigest({ oid, bvid, root, parent, message }) {
  return createHash('sha256').update(JSON.stringify([oid, bvid || '', root || '', parent || '', message].map(String))).digest('hex')
}
