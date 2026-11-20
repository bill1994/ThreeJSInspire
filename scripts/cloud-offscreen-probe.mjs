/** Cloud reflection A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/cloud-reflection-probe.mjs stage5
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = 'cloud-flight-occlusion';
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=12&todspeed=0&alt=60&headlight=off&bgmotion=spatial&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0'});
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));if(await evaluate('Boolean(window.__porco?.qa)').catch(()=>false))break;}
 const flight=await evaluate(`(async()=>{
 const a=__porco,{cloudViewTest}=await import('/src/cloud-arrival.ts');
 a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();
 const clouds=[...a.scene.getObjectByName('puff-field').children,...a.scene.getObjectByName('bg_cloud_field').children];
 const history=new Map();let births=0,onscreenBirths=0;const examples=[];
 const read=c=>({ready:c.userData.cloudPrepared,generation:c.userData.world?.generation||0,x:c.position.x,z:c.position.z});
 clouds.forEach(c=>history.set(c,read(c)));
 const base=a.qa.elapsed;
 for(let i=1;i<=1200;i++){
  const t=i*.05;a.camera.position.set(t*30,100,-t*80);a.camera.rotation.set(-.12,Math.sin(t*.13)*2,0,'YXZ');a.camera.updateMatrixWorld();
  a.qa.farField.update(a.camera.position.x,a.camera.position.z,100,0,-1,base+t,a.camera);
  a.world.updateBgView(base+t,a.camera.position,a.camera);
  const outside=cloudViewTest(a.camera);
  for(const c of clouds){const prev=history.get(c),now=read(c),w=c.userData.world;
   const recycled=w ? now.generation!==prev.generation : Math.hypot(now.x-prev.x,now.z-prev.z)>400;
   if(now.ready&&(!prev.ready||recycled)){
    births++;let center=c.position.clone(),radius;
    if(w){center.set(w.x,w.y,w.z);radius=Math.hypot(c.scale.x,c.scale.y)*center.distanceTo(a.camera.position)/800;}
    else {const b=c.userData.blobSize;radius=Math.hypot(b.halfW,b.halfD,b.halfH);}
    if(!outside(center,radius)){onscreenBirths++;examples.push({name:c.name,t});}
   } history.set(c,now);
  }
  if(i%60===0){a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();}
 }
 return {births,onscreenBirths,examples,seconds:60};})()`);
 if(flight.births<2||flight.onscreenBirths)throw new Error('Offscreen cloud regression: '+JSON.stringify(flight));
 const screenshot=async name=>{const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));};
 await screenshot('after-turning-flight');
 await evaluate(`(()=>{const a=__porco,source=a.scene.getObjectByName('bg_cloud_backdrop').children[2];window.fixture=a.scene.clone(false);fixture.background=null;window.front=source.clone();window.back=source.clone();front.position.set(0,0,-200);front.rotation.set(0,0,0);front.scale.set(70,70,1);front.renderOrder=2;back.position.set(0,0,-240);back.rotation.set(0,0,0);back.scale.set(100,100,1);back.material=new source.material.constructor({color:0xff0000,depthWrite:false});back.renderOrder=1;fixture.add(back,front);a.camera.position.set(0,0,0);a.camera.rotation.set(0,0,0);a.camera.updateMatrixWorld();})()`);
 for(const show of [false,true]){
  await evaluate(`(async()=>{back.visible=${show};__porco.renderer.render(fixture,__porco.camera);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();})()`);await screenshot('occlusion-'+show);
 }
 writeFileSync(root+'/report.json',JSON.stringify({flight,errors},null,2));console.log(JSON.stringify({root,flight,errors}));if(errors.length)throw new Error('Browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
