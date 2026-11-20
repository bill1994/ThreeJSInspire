/** Upper-sky startup coverage and world anchoring through camera turns.
 * Start isolated Chrome on 9223 and Vite; node scripts/upper-cloud-probe.mjs upper-sky
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'upper-sky';
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
 await evaluate(`(async()=>{for(let i=0;i<30;i++){__porco.qa.step(1,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();}window.reviewEye=__porco.camera.position.clone();})()`);
 const reports=[];
 const capture=async(name)=>{const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));};
 await capture('level');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:250,y:380,button:'left',clickCount:1});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:250,y:285,button:'left',buttons:1});
 await evaluate(`(async()=>{for(let i=0;i<90;i++){__porco.qa.step(1,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();}})()`);
 await capture('climb');
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:250,y:285,button:'left',clickCount:1});
 for(const [yaw,pitch] of [[0,35],[90,35],[180,35],[270,35],[0,70],[0,85]]){
  reports.push(await evaluate(`(async()=>{const a=__porco,y=${yaw}*Math.PI/180,p=${pitch}*Math.PI/180;a.camera.position.copy(reviewEye);a.camera.up.set(0,1,0);a.camera.lookAt(reviewEye.x+1000*Math.sin(y)*Math.cos(p),reviewEye.y+1000*Math.sin(p),reviewEye.z-1000*Math.cos(y)*Math.cos(p));a.world.updateBgView(a.qa.elapsed,a.camera.position,a.camera);a.scene.getObjectByName('sky_sunset_tsl').position.copy(a.camera.position);a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();return {yaw:${yaw},pitch:${pitch},clouds:a.scene.getObjectByName('bg_cloud_field').children.filter(c=>c.name.startsWith('bg_upper_')).map(c=>({name:c.name,visible:c.visible,world:{...c.userData.world},opacity:c.userData.opacity,screen:c.position.clone().project(a.camera).toArray()}))};})()`));
  await capture('view-'+yaw+'-'+pitch);
 }
 const first=reports[0].clouds;
 const stable=reports.every(r=>r.clouds.every((c,i)=>JSON.stringify(c.world)===JSON.stringify(first[i].world)));
 const prepared=first.length===10&&first.every(c=>c.visible&&c.opacity>.99);
 writeFileSync(root+'/report.json',JSON.stringify({reports,stable,prepared,errors},null,2));console.log(root,JSON.stringify({stable,prepared,errors}));
 if(!stable||!prepared||errors.length)throw new Error('Upper sky acceptance failed');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
