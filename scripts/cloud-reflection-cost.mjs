/** Cloud reflection A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/cloud-reflection-cost.mjs stage5-cost
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=12&bgmotion=spatial&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0'});
 let ready=false;
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);if(ready)break;}
 if(!ready)throw new Error('boot timeout');
 await evaluate(`(async()=>{const a=__porco;for(let i=0;i<90;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}})()`);
 const reports=[];
 // Isolate cloud contribution from the stronger sky reflection, at identical waves.
 for(const show of [true,false,true]) {
  await evaluate(`(async()=>{const a=__porco;a.world.setBgVisible(${show});a.world.updateBgView(a.world.sea.time,a.camera.position);a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/cloud-'+show+'-'+reports.length+'.png',Buffer.from(shot.data,'base64'));reports.push({show});
 }
 for(const [on,high] of [[false,true],[true,true],[false,true],[true,false],[false,false]]) {
  const data=await evaluate(`(async()=>{const a=__porco;a.world.sea.setCloudReflection(${on});a.qa.setQuality(${high});const samples=[];for(let i=0;i<150;i++){const before=a.world.sea.reflectionCaptures;const start=performance.now();a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();if(i>=30)samples.push({ms:performance.now()-start,capture:a.world.sea.reflectionCaptures>before});}return {samples,memory:a.renderer.info.memory,captures:a.world.sea.reflectionCaptures};})()`);
  const q=(v,p)=>v.sort((a,b)=>a-b)[Math.floor((v.length-1)*p)];const t=data.samples.map(s=>s.ms),capture=data.samples.filter(s=>s.capture).map(s=>s.ms);
  const report={on,high,p50:q([...t],.5),p95:q([...t],.95),captureP50:capture.length?q(capture,.5):null,captureFrames:capture.length,...data};reports.push(report);console.log(JSON.stringify({on,high,p50:report.p50,p95:report.p95,captureP50:report.captureP50,captureFrames:capture.length}));
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Reflection browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
