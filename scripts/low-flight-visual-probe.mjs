/** Low-altitude visual acceptance across daylight and quality tiers.
 * Start isolated Chrome on 9223 and Vite; node scripts/low-flight-visual-probe.mjs low-flight
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'low-flight';
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=17&todspeed=0&alt=60'});
 let ready=false;
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);if(ready)break;}
 if(!ready)throw new Error('App boot timeout');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:250,y:350,button:'left',clickCount:1});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:250,y:435,button:'left',buttons:1});
 await evaluate(`(async()=>{for(let i=0;i<300;i++){__porco.qa.step(1,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();}})()`);
 const reports=[];
 for(const h of [6,12,17,0])for(const high of [true,false]){
  const state=await evaluate(`(async()=>{const a=__porco;a.qa.setTod(${h});a.qa.setQuality(${high});for(let i=0;i<90;i++){a.qa.step(1,0);await a.renderer.backend.device.queue.onSubmittedWorkDone();}return a.qa.describe();})()`);
  const name=h+'-'+(high?'high':'low');
  const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));reports.push({name,state});
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(root,JSON.stringify(errors));
 if(errors.length)throw new Error('Browser errors: see report');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
