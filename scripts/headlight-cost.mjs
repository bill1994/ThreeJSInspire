/** Aircraft headlight A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/headlight-cost.mjs stage6-cost
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ablation';
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
 await send('Emulation.setDeviceMetricsOverride',{width:570,height:800,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=0&headlight=auto&bgmotion=spatial&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0'});
 let ready=false;for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);if(ready)break;}if(!ready)throw new Error('boot timeout');
 const reports=[];
 for(const [mode,high] of [['off',true],['on',true],['off',true],['on',false],['off',false]]) {
  const data=await evaluate(`(async()=>{const a=__porco;a.qa.setHeadlight('${mode}');a.qa.setQuality(${high});const times=[];for(let i=0;i<150;i++){const t=performance.now();a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();if(i>=30)times.push(performance.now()-t);}return {times,pose:a.game.pose()};})()`);
  const times=[...data.times].sort((a,b)=>a-b);reports.push({mode,high,p50:times[59],p95:times[113],...data});console.log(JSON.stringify({mode,high,p50:times[59],p95:times[113]}));
 }
 for(const hour of [12,0,6]) {
  const state=await evaluate(`(async()=>{const a=__porco;a.qa.setHeadlight('auto');a.qa.setTod(${hour});for(let i=0;i<48;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}return {strength:a.world.headlight.uniforms.strength.value,visible:a.scene.getObjectByName('porco_headlight_beam').visible};})()`);
  if(hour===12&&state.strength!==0)throw new Error('Day auto stays lit');if(hour===0&&state.strength!==1)throw new Error('Night auto stays off');reports.push({hour,...state});
 }
 await evaluate(`document.querySelector('.porco-hud__toggle').click();document.getElementById('porco-headlight').value='on';document.getElementById('porco-headlight').dispatchEvent(new Event('change'))`);await new Promise(r=>setTimeout(r,700));
 const ui=await evaluate(`({mode:__porco.world.headlight.mode,strength:__porco.world.headlight.uniforms.strength.value,select:document.getElementById('porco-headlight').value})`);
 if(ui.mode!=='on'||ui.strength!==1)throw new Error('HUD switch failed');reports.push({ui});
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/ui.png',Buffer.from(shot.data,'base64'));
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Headlight browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
