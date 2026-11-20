/** Aircraft headlight A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/headlight-probe.mjs stage6
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
 const reports=[];await evaluate(`window.cloudOriginal=__porco.scene.getObjectByName('puff-field').children[0].position.clone()`);
 for(const scenario of ['cruise','low','cloud','side']) {
  await evaluate(`(async()=>{const a=__porco;a.scene.getObjectByName('puff-field').children[0].position.copy(window.cloudOriginal);a.qa.setTod(0);a.game.setPose(0,${scenario==='low'?12:60},0);for(let i=0;i<48;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}const p=a.game.pose();if('${scenario}'==='cloud'){const c=a.scene.getObjectByName('puff-field').children[0];c.position.set(p.x,p.y+10,p.z-85);c.material.userData.edgeFade.value=1;}if('${scenario}'==='side'){a.camera.position.set(p.x+35,p.y+15,p.z+40);a.camera.lookAt(p.x,p.y,p.z-16);}a.camera.updateMatrixWorld();})()`);
  for(const light of ['off','on']){
   const state=await evaluate(`(async()=>{const a=__porco;a.qa.setHeadlight('${light}');a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();const u=a.world.headlight.uniforms;return {position:u.position.value.toArray(),direction:u.direction.value.toArray(),strength:u.strength.value};})()`);
   const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+scenario+'-'+light+'.png',Buffer.from(shot.data,'base64'));reports.push({scenario,light,state});
  }
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Headlight browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
