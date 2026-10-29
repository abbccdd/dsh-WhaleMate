#!/usr/bin/env node
import { storageStats } from '../lib/storage-stats.mjs'
try {
  if (process.argv[2] && process.argv[2] !== 'status') throw new Error('用法：storage.mjs status')
  process.stdout.write(JSON.stringify(storageStats()) + '\n')
} catch (error) {
  process.stderr.write('存储统计失败：' + error.message + '\n')
  process.exitCode = 1
}
