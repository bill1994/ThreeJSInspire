/** Continuous player input/frame-interval sample in a separate browser tab.
 * Start isolated Chrome on 9223 and Vite; node scripts/player-live-probe.mjs player-live
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'player-baseline';
const root = `artifacts/sea-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(root, { recursive: true });
const target = await (await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0;
const pending = new Map(), errors = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) {
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown' ||
      (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' &&
        !m.params.entry.url?.endsWith('/favicon.ico')) ||
      (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) errors.push(m);
};
function send(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 120000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}



try {
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:500,height:660,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?tod=17&todspeed=0&alt=60'});
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));if(await evaluate('Boolean(window.__porco?.qa)').catch(()=>false))break;}
 await new Promise(r=>setTimeout(r,6000));
 await evaluate(`window.__reviewFrames=[];window.__reviewLast=performance.now();window.__reviewRunning=true;function reviewTick(t){if(!window.__reviewRunning)return;window.__reviewFrames.push(t-window.__reviewLast);window.__reviewLast=t;requestAnimationFrame(reviewTick)}requestAnimationFrame(reviewTick)`);
 const reports=[];
 for(const [name,dx,dy] of [['climb',0,-65],['release',0,0],['right',65,0],['release2',0,0],['dive',0,65]]){
 if(dx||dy){await send('Input.dispatchMouseEvent',{type:'mousePressed',x:250,y:380,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:250+dx,y:380+dy,button:'left',buttons:1});}
 await new Promise(r=>setTimeout(r,2000));
 reports.push({name,...await evaluate('({state:__porco.qa.describe(),frames:__porco.qa.frameStats()})')});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:250+dx,y:380+dy,button:'left',clickCount:1});
 const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));
 }
 const timing=await evaluate(`(()=>{window.__reviewRunning=false;const a=window.__reviewFrames.slice(1).sort((a,b)=>a-b);return {count:a.length,mean:a.reduce((s,v)=>s+v,0)/a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)}})()`);
 writeFileSync(root+'/report.json',JSON.stringify({reports,timing,errors},null,2));console.log(root,JSON.stringify(timing),JSON.stringify(errors));
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
