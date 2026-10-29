window.__ModuleLoader__.load({
  id: 'dsh-pond',
  factory: (require) => {
    const module = { exports: {} }, exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect } = React
    const endpoint = '/dsh-pond/api/settings-ui'
    const css = [
      '.pond-settings{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:8px}',
      '.pond-settings h2{font-size:16px;font-weight:600;line-height:24px;margin:0}',
      '.pond-settings p{font-size:13px;line-height:20px;margin:0;color:var(--dsw-alias-label-tertiary)}',
      '.pond-settings h3{font-size:13px;font-weight:600;line-height:20px;margin:18px 0 0}',
      '.pond-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.pond-row-text{flex:1;min-width:0}.pond-label{font-size:13px;line-height:20px;font-weight:500}',
      '.pond-hint{font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary);margin-top:3px}',
      '.pond-toggle{position:relative;width:44px;height:26px;flex:none;display:inline-flex;align-items:center;cursor:pointer}',
      '.pond-toggle input{position:absolute;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
      '.pond-track{width:44px;height:24px;border-radius:20px;background:var(--dsw-alias-border-l2);transition:background .15s}',
      '.pond-track:after{content:"";display:block;width:18px;height:18px;margin:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0004;transition:transform .15s}',
      '.pond-toggle input:checked + .pond-track{background:var(--dsw-alias-brand-primary)}',
      '.pond-toggle input:checked + .pond-track:after{transform:translateX(20px)}',
      '.pond-toggle input:focus-visible + .pond-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}',
      '.pond-toggle input:disabled + .pond-track{opacity:.5}.pond-status{min-height:20px;font-size:12px;line-height:20px}',
      '.pond-error{color:var(--dsw-alias-state-error-primary)}',
      '@media(prefers-reduced-motion:reduce){.pond-track,.pond-track:after{transition:none}}',
    ].join('')
    const rows = [
      {section:'视频素材',key:'cleanVideos',label:'看完后清理视频原片',hint:'仅清理成功读取的本轮视频。当前流式看视频不会保存原片。'},
      {section:'视频素材',key:'cleanFrames',label:'看完后清理临时拼图',hint:'记录完成后清理本轮已读取的抽帧与配套字幕图。失败时保留。'},
      {section:'QQ 互动',key:'proactive',label:'主动分享视频到 QQ',hint:'刷站完成后分享给已绑定的主人；每 24 小时最多尝试一次，还受 QQ 平台额度限制。'},
      {section:'记忆',key:'autoMemory',label:'自动提炼长期记忆',hint:'回复后提炼可能有长期价值的非敏感内容，仅供已绑定的主人私聊使用。'},
    ]
    async function request(options) {
      const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',...options})
      const result=await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error || '设置无法保存，请重试')
      return result
    }
    function PondSection() {
      const [settings,setSettings]=useState(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[pairCode,setPairCode]=useState('')
      useEffect(()=>{
        if (!document.getElementById('dsh-pond-settings-style')) {const style=document.createElement('style');style.id='dsh-pond-settings-style';style.textContent=css;document.head.appendChild(style)}
        let alive=true
        request().then(value=>{if(alive)setSettings(value)}).catch(()=>{if(alive)setError('无法读取设置，请确认鱼塘插件已启动并刷新页面。')})
        return ()=>{alive=false}
      },[])
      async function change(key,enabled) {
        setBusy(true);setNotice('正在保存…');setError('')
        try {
          await request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setting:key,enabled})})
          setSettings(previous=>({...previous,[key]:enabled}));setNotice('已保存')
        } catch (e) {setNotice('');setError(e.message || '设置未保存，请重试。')}
        finally {setBusy(false)}
      }
      async function setup(action) {
        setBusy(true);setNotice('正在处理…');setError('')
        try {
          const response=await fetch('/dsh-pond/api/settings-setup',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})})
          const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error || '设置失败')
          if(action==='pair'){setPairCode(result.code);setNotice('请将配对码发给 QQ 机器人，然后点击“完成配对”。')}
          else {setPairCode('');setNotice(action==='activate'?'主人会话已绑定。':action==='profile'?'原版公开人设已连接。':'原版报告和日记已连接。')}
          const current=await request();setSettings(current)
        } catch(e){setNotice('');setError(e.message || '设置失败，请先完成 QQ 或 B 站配置。')}
        finally{setBusy(false)}
      }
      let last=''
      const elements=[]
      for (const row of rows) {
        if(row.section!==last){last=row.section;elements.push(h('h3',{key:'section-'+last},last))}
        const id='pond-setting-'+row.key
        elements.push(h('div',{className:'pond-row',key:row.key},
          h('div',{className:'pond-row-text'},h('label',{className:'pond-label',htmlFor:id},row.label),h('div',{className:'pond-hint',id:id+'-hint'},row.hint),row.key==='proactive'&&settings?.shareNotice?h('div',{className:'pond-hint pond-error'},settings.shareNotice):null),
          h('label',{className:'pond-toggle'},h('input',{id,type:'checkbox',role:'switch','aria-describedby':id+'-hint',checked:!!settings?.[row.key],disabled:!settings||busy,onChange:e=>change(row.key,e.target.checked)}),h('span',{className:'pond-track','aria-hidden':'true'}))))
      }
      const button=(action,label)=>h('button',{type:'button',disabled:busy,onClick:()=>setup(action),style:{marginRight:'8px',marginTop:'8px'}},label)
      return h('div',{className:'pond-settings'},h('h2',null,'鲸伴'),h('p',null,'管理视频素材和与主人的 QQ 互动。开关更改后立即生效。'),...elements,
        h('h3',null,'连接 QQ 主人'),h('p',null,settings?.qqOwner?.bound?'已配对；如需连接记忆，请点击完成配对。':'先在“QQ 机器人”设置中扫码连接，再生成配对码。'),
        h('div',null,button('pair','生成配对码'),button('activate','完成配对')),
        pairCode?h('p',null,'将这条消息发给机器人：',h('strong',null,pairCode)):null,
        h('h3',null,'连接 B 站资料'),h('p',null,'先在“养鱼”中完成 B 站设置并生成原版资料，再按需连接。'),
        h('div',null,button('profile','连接公开人设'),button('documents','连接报告和日记')),
        h('div',{className:'pond-status'+(error?' pond-error':''),role:'status','aria-live':'polite'},error||notice||(!settings?'正在读取设置…':'')))
    }
    function apply(ctx) {
      ctx.effect(()=>ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'dsh-pond',order:7,label:()=> '鲸伴'},PondSection),'dsh-pond: settings section'),'dsh-pond: settings section')
    }
    exports.apply=apply;exports.inject=['slots'];exports.PondSection=PondSection
    return module.exports
  },
})
