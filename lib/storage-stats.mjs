/** Count storage without opening chat files, following links, or modifying history. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LIMIT = 512 * 1024 * 1024
function sizeTree(root) {
  let bytes = 0, files = 0
  if (!fs.existsSync(root)) return { bytes, files }
  const first = fs.lstatSync(root)
  if (!first.isDirectory() || first.isSymbolicLink()) throw new Error('存储目录不是普通目录')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(filename)
      else if (entry.isFile()) { bytes += fs.statSync(filename).size; files++ }
    }
  }
  return { bytes, files }
}

export function storageStats({home = os.homedir(), dshHome = process.env.DSH_HOME || path.join(home, '.dsh'), pondHome = process.env.POND_HOME || path.join(dshHome, 'pond'), threshold = LIMIT} = {}) {
  const sessions = sizeTree(path.join(dshHome, 'sessions'))
  const pond = sizeTree(pondHome)
  const reports = sizeTree(path.join(home, '.bili-ai', 'out'))
  const shots = sizeTree(path.join(dshHome, 'shots'))
  return { sessions, pond, reports, shots, threshold, sessionsAboveThreshold: sessions.bytes >= threshold }
}
