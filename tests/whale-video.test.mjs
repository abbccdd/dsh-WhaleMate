import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Pond } from '../lib/store.mjs'
import { bindLearning } from '../lib/memory.mjs'
import { analyzeWhaleVideo } from '../lib/whale-video.mjs'

function fixture() {
  const base = path.resolve('待删除文件', '鲸鱼视频链路测试'); fs.mkdirSync(base, { recursive: true })
  const home = fs.mkdtempSync(path.join(base, 'case-')), root = path.join(home, 'whale')
  fs.mkdirSync(path.join(root, 'tools', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(home, 'shots', 'video'), { recursive: true }); fs.mkdirSync(path.join(home, 'shots', 'subs'))
  fs.writeFileSync(path.join(root, 'tools', 'lib', 'ffmpeg.mjs'), "export const requireFfmpeg = () => 'ffmpeg'\n")
  const img = path.join(home, 'shots', 'video', 'BV1vJnN64E8Q-example-4x4.jpg')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=640x360:color=red', '-frames:v', '1', '-update', '1', img])
  const entry = `import fs from 'node:fs'; import path from 'node:path';\nconst home=process.env.DSH_HOME; fs.writeFileSync(path.join(home,'args.json'), JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(path.join(home,'shots','subs','BV1vJnN64E8Q-debrief.txt'),'公开字幕示例');\nconsole.log('标题: 虚构视频'); console.log('有字幕：1 行'); console.log('SHEET: '+path.join(home,'shots','video','BV1vJnN64E8Q-example-4x4.jpg'));\n`
  fs.writeFileSync(path.join(root, 'tools', 'bili.mjs'), entry)
  const store = Pond.open(path.join(home, 'pond')); store.init(); bindLearning(store, 'session:owner', 'owner'); bindLearning(store, 'session:other', 'watcher')
  return {home,root,store,owner:{principal:'session:owner',scopes:['documents:read']}}
}

test('QQ 视频只传 BV 给已安装 whale 的 debrief，返回 4×4 和新字幕', async () => {
  const {home,root,store,owner} = fixture()
  const r = await analyzeWhaleVideo(store, owner, 'BV1vJnN64E8Q', {dshHome:home, whaleRoot:root})
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'args.json'), 'utf8')), ['debrief','BV1vJnN64E8Q','--grid','4x4'])
  assert.equal(r.source, 'bili-whale debrief'); assert.equal(r.frameGrid, '4x4'); assert.match(r.frameSheet, /-pond-4x4\.jpg$/)
  assert.match(r.subtitle.text, /公开字幕示例/); assert.match(r.publicEvidence, /虚构视频/); assert.equal(r.warning, undefined)
  const width = execFileSync('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width','-of','csv=p=0',r.frameSheet], {encoding:'utf8'}).trim()
  assert.equal(width, '1440')
})

test('不允许非主人、无权、非法 BV 或伪造抽帧路径', async () => {
  const {home,root,store,owner} = fixture(), options = {dshHome:home,whaleRoot:root}
  await assert.rejects(analyzeWhaleVideo(store,{principal:'session:other',scopes:owner.scopes},'BV1vJnN64E8Q',options), /主人/)
  await assert.rejects(analyzeWhaleVideo(store,{principal:'session:owner',scopes:[]},'BV1vJnN64E8Q',options), /主人/)
  await assert.rejects(analyzeWhaleVideo(store,owner,'../../secret',options), /BV/)
  assert.equal(fs.existsSync(path.join(home,'args.json')), false)
  fs.writeFileSync(path.join(root,'tools','bili.mjs'), "console.log('SHEET: C:/outside/BV1vJnN64E8Q-4x4.jpg')")
  await assert.rejects(analyzeWhaleVideo(store,owner,'BV1vJnN64E8Q',options), /不可信/)
})

test('未安装原插件或流程失败时明确报错', async () => {
  const {home,root,store,owner} = fixture()
  await assert.rejects(analyzeWhaleVideo(store,owner,'BV1vJnN64E8Q',{dshHome:home,whaleRoot:path.join(home,'missing')}), /安装/)
  fs.writeFileSync(path.join(root,'tools','bili.mjs'), 'process.exit(1)')
  await assert.rejects(analyzeWhaleVideo(store,owner,'BV1vJnN64E8Q',{dshHome:home,whaleRoot:root}), /失败或超时/)
})
