/** World-space background cloud acceptance. Isolated Chrome/CDP on 9223, Vite on 5173.
 * node scripts/bg-cloud-flight-probe.mjs
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'spatial';
const root = `artifacts/bg-flight-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=6&bgmotion=spatial&bglook=form&bgwrite=replace&puff=0&sealook=painted&bgq=512&toon=0&dof=0'});
 let ready=false;
 for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,500));ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);if(ready)break;}
 if(!ready)throw new Error('boot timeout');
 await evaluate(`(async()=>{
  for(let i=0;i<24;i++){__porco.qa.step(1,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();}
  const a=__porco;window.field=a.scene.getObjectByName('bg_cloud_field');
  if(!field||field.children.length<7)throw new Error('spatial clouds missing');
  a.scene.children.forEach(c=>c.visible=c.name==='sky_sunset_tsl'||c===field);
  document.querySelectorAll('.porco-hud').forEach(e=>e.style.visibility='hidden');
  window.copies=0;const copy=a.renderer.copyTextureToTexture.bind(a.renderer);a.renderer.copyTextureToTexture=(...v)=>{if(v[1]?.name?.startsWith('bg_cloud_tile_'))copies++;return copy(...v);};
  window.move=async(x,z,t)=>{
   const y=315*Math.PI/180;a.camera.position.set(x,70,z);a.camera.lookAt(x+Math.sin(y)*1000,420,z-Math.cos(y)*1000);a.camera.updateMatrixWorld();
   a.world.update(t,1/60,{camera:a.camera.position,radPerPixel:.001});a.world.updateBgView(t,a.camera.position);
   a.scene.getObjectByName('sky_sunset_tsl').position.copy(a.camera.position);a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();
   return field.children.map(c=>({world:{...c.userData.world},opacity:c.userData.opacity,screen:c.position.clone().project(a.camera).toArray()}));
  };
 })()`);
 const poses=[];
 for(const [i,x] of [0,500,1000].entries()){
  poses.push(await evaluate('move('+x+',0,'+(10+i)+')'));
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/translate-'+x+'.png',Buffer.from(shot.data,'base64'));
 }
 const travel=await evaluate(`(()=>{
  const a=__porco;const events=[];let t=20;
  for(let z=0;z>=-60000;z-=100){
   const before=field.children.map(c=>({generation:c.userData.world.generation,opacity:c.userData.opacity}));
   a.camera.position.set(1000,70,z);a.world.updateBgView(t+=.1,a.camera.position);
   field.children.forEach((c,i)=>{const p=c.userData.world;if(p.generation!==before[i].generation)events.push({i,before:before[i].opacity,after:c.userData.opacity,distance:Math.hypot(p.x-1000,p.z-z)});});
  }
  return {events,copies};
 })()`);
 const moved=poses[0].some((p,i)=>Math.abs(p.screen[0]-poses[2][i].screen[0])>.02);
 const anchored=poses[0].every((p,i)=>['x','y','z'].every(k=>p.world[k]===poses[2][i].world[k]));
 const safe=travel.events.length>0&&travel.events.every(e=>e.before<.02&&e.after===0&&e.distance>=14499);
 const report={poses,travel,moved,anchored,safe,errors};writeFileSync(root+'/report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({root,moved,anchored,safe,recycles:travel.events.length,copies:travel.copies,errors}));
 if(!moved||!anchored||!safe||travel.copies!==0||errors.length)throw new Error('Cloud flight regression');
} finally {await send('Page.close').catch(()=>{});ws.close();}
