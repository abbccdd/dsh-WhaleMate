import fs from 'node:fs'
globalThis.fetch = async (url, opts = {}) => {
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({url:String(url),method:opts.method ?? 'GET'})+'\n')
  let data
  if (String(url).includes('/x/v2/reply/reply')) {
    const u = new URL(url)
    data = u.searchParams.get('type') === '11' && u.searchParams.get('root') === '9'
      ? { code: 0, data: { replies: [], root: { rpid: 9, mid: 222, member: { uname: 'Owner' } } } }
      : { code: -404 }
    return { status: 200, ok: true, json: async () => data }
  }
  if (process.env.TEST_DM_FILE && String(url).includes('/get_sessions')) {
    const last = JSON.parse(fs.readFileSync(process.env.TEST_DM_FILE, 'utf8'))
    data = { code: 0, data: { session_list: [{ talker_id: 222, last_msg: last }] } }
    return { status: 200, ok: true, json: async () => data }
  }
  if (process.env.TEST_FEEDS && String(url).includes('/x/msgfeed/')) {
    const feeds=JSON.parse(fs.readFileSync(process.env.TEST_FEEDS,'utf8'))
    const kind=new URL(String(url)).pathname.split('/').pop()
    if(feeds[kind]?.error)throw Error('mock inbox unavailable')
    data={code:0,data:{items:feeds[kind]??[]}}
    return {status:200,ok:true,json:async()=>data}
  }
  if (String(url).includes('/nav')) data={code:0,data:{isLogin:true,mid:111,uname:'test-account'}}
  else if(String(url).includes('/x/relation'))data={code:0,data:{attribute:6}}
  else if(String(url).includes('/send_msg'))data={code:0,data:{}}
  else if(String(url).includes('/x/v2/reply/add'))data={code:0,data:{rpid:123}}
  else throw Error('Network blocked by test: '+url)
  return {status:200,ok:true,json:async()=>data}
}
