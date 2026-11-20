/** Scene grade A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/scene-grade-probe.mjs stage3
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ablation';
const root = `artifacts/scene-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
 let ready=false;for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);if(ready)break;}if(!ready)throw new Error('boot timeout');
 const reports=[];
 for(const h of [12,0,6,17.59,18.5]) {
  await evaluate(`(async()=>{const a=__porco;a.qa.setTod(${h});for(let i=0;i<24;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}window.flightQuaternion=a.camera.quaternion.clone();})()`);
  for(const version of ['previous','refined']) {
   const state=await evaluate(`(async()=>{const a=__porco;a.qa.setColorGrade(${version==='refined'});for(let i=0;i<24;i++){a.qa.step(1,0);await a.renderer.backend.device.queue.onSubmittedWorkDone();}return {sun:a.qa.getSun(),color:a.qa.exportColorState()};})()`);
   for(const pose of ['flight','away']) {
    await evaluate(`(async()=>{const a=__porco;if('${pose}'==='flight'){a.camera.quaternion.copy(flightQuaternion);}else{const s=a.qa.getSun(),y=(s.azimuthDeg+${h===0?0:180})*Math.PI/180,c=a.camera.position;a.camera.lookAt(c.x+Math.sin(y)*1000,c.y-200,c.z-Math.cos(y)*1000);}a.camera.updateMatrixWorld();a.post.render();await a.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
    let shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+h+'-'+pose+'-'+version+'.png',Buffer.from(shot.data,'base64'));
    if(pose==='flight'){
     await evaluate(`(async()=>{const a=__porco;window.visibility=a.scene.children.map(c=>c.visible);window.oldBackground=a.scene.background;const T=await import('/node_modules/three/build/three.module.js');a.scene.background=new T.Color(0);a.scene.children.forEach(c=>c.visible=c.isLight||c.name==='porco_root');a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
     shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+h+'-plane-'+version+'.png',Buffer.from(shot.data,'base64'));
     await evaluate('(()=>{const a=__porco;a.scene.children.forEach((c,i)=>c.visible=visibility[i]);a.scene.background=oldBackground;})()');
    }
   }
   reports.push({h,version,...state});
  }
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Scene grade browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
