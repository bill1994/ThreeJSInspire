/** Cloud reflection A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/cloud-reflection-probe.mjs stage5
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'sky-line-check';
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=15.883333333&todspeed=0&alt=60&headlight=off&bgmotion=spatial&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0'});
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));if(await evaluate('Boolean(window.__porco?.qa)').catch(()=>false))break;}
 await evaluate(`(async()=>{const a=__porco;for(let i=0;i<90;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}window.flightQuaternion=a.camera.quaternion.clone();})()`);
 const reports=[];
 for(const pose of ['flight','sunward'])for(const mode of ['full','no-objects','no-clouds','raw']){
  const result=await evaluate(`(async()=>{const a=__porco;a.camera.quaternion.copy(flightQuaternion);
   if('${pose}'==='sunward'){const s=a.qa.getSun(),y=s.azimuthDeg*Math.PI/180,c=a.camera.position;a.camera.lookAt(c.x+Math.sin(y)*1000,c.y-120,c.z-Math.cos(y)*1000);}
   a.camera.updateMatrixWorld();a.world.sea.setObjectReflection('${mode}'==='full');a.world.sea.setCloudReflection('${mode}'!=='no-clouds');a.world.setBgVisible('${mode}'!=='no-clouds');a.world.setPuffVisible('${mode}'!=='no-clouds');
   a.world.updateBgView(a.qa.elapsed,a.camera.position,a.camera);a.world.sea.updateObjectReflection(a.scene,a.camera,a.qa.elapsed+1);
   if('${mode}'==='raw')a.renderer.render(a.scene,a.camera);else a.post.render();await a.renderer.backend.device.queue.onSubmittedWorkDone();return a.qa.getSun();})()`);
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+pose+'-'+mode+'.png',Buffer.from(shot.data,'base64'));reports.push({pose,mode,sun:result});
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
