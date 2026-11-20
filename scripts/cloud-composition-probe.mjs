/** Cloud composition preview and coverage capture. Start isolated Chrome on 9223 and Vite.
 * node scripts/cloud-composition-probe.mjs composition
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ablation';
const root = `artifacts/sky-audit-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
 const reports=[];
 for(const layout of ['legacy','composed']) {
  await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=12&cloudlayout='+layout+'&bgmotion=spatial&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0'});
  let ready=false;
  for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);if(ready)break;}
  if(!ready)throw new Error('boot timeout');
  const metrics=await evaluate(`(async()=>{const a=__porco;for(let i=0;i<24;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}
   const times=[];for(let i=0;i<60;i++){const t=performance.now();a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();times.push(performance.now()-t);}times.sort((a,b)=>a-b);
   return {p50:times[30],p95:times[57],textures:a.renderer.info.memory.textures};})()`);
  reports.push({layout,...metrics});
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+layout+'.png',Buffer.from(shot.data,'base64'));
 }
 await evaluate(`(async()=>{const a=__porco;const T=await import('/node_modules/three/build/three.module.js');a.scene.background=new T.Color(0);a.scene.children.forEach(c=>c.visible=c.name==='bg_cloud_backdrop');a.camera.position.set(0,70,0);a.world.updateBgView(0,a.camera.position);})()`);
 for(const pitch of [-15,0,15]) for(let yaw=0;yaw<360;yaw+=10) {
  await evaluate(`(async()=>{const a=__porco;const y=${yaw}*Math.PI/180,p=${pitch}*Math.PI/180;a.camera.lookAt(Math.sin(y)*Math.cos(p)*1000,70+Math.sin(p)*1000,-Math.cos(y)*Math.cos(p)*1000);a.camera.updateMatrixWorld();a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/mask-'+pitch+'-'+yaw+'.png',Buffer.from(shot.data,'base64'));
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,reports,errors}));
 if(errors.length)throw new Error('Cloud composition browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
