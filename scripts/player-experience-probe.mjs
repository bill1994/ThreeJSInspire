/** Player input/camera comparison through real CDP mouse drags and fixed frames.
 * Start isolated Chrome on 9223 and Vite; node scripts/player-experience-probe.mjs player-after
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
 await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=17&todspeed=0&alt=60'});
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));if(await evaluate('Boolean(window.__porco?.qa)').catch(()=>false))break;}
 const reports=[];
 async function frames(n){return evaluate(`(async()=>{for(let i=0;i<${n};i++){__porco.qa.step(1,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();}})()`);}
 async function capture(name){const result=await evaluate(`(()=>{const a=__porco,p=a.game.pose(),v=a.camera.position.clone();a.camera.getWorldDirection(v);return {state:a.qa.describe(),cameraDirection:v.toArray(),planeScreen:a.camera.position.clone().set(p.x,p.y,p.z).project(a.camera).toArray(),text:document.body.innerText};})()`);const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));reports.push({name,...result});console.log(name,result.state.plane,result.cameraDirection);}
 async function drag(dx,dy){await send('Input.dispatchMouseEvent',{type:'mousePressed',x:450,y:390,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:450+dx,y:390+dy,button:'left',buttons:1});}
 async function release(){await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:450,y:390,button:'left',clickCount:1});}
 await frames(60);await capture('level');await drag(0,-85);await frames(90);await capture('climb');await release();await frames(45);await capture('release-climb');await frames(90);await drag(0,85);await frames(120);await capture('dive');await frames(180);await capture('low-dive');await release();await frames(60);await drag(85,0);await frames(120);await capture('turn-right');await release();await frames(60);await drag(-85,0);await frames(120);await capture('turn-left');await release();await frames(60);await capture('settled');
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(root,JSON.stringify(errors));
} finally {ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
