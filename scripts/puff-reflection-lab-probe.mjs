/** Local WebGPU acceptance probe. Start isolated Chrome on port 9223 and Vite.
 * node scripts/cloud-reflection-lab-probe.mjs stage5-lab
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ablation';
const root = `artifacts/puff-soft-sky-audit-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
 await send('Emulation.setDeviceMetricsOverride',{width:1100,height:950,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:5173/puff-reflection-lab.html'});
 const reports=[];
 for(const [hour,yaw,quality] of [['12','puff','high'],['0','puff','low'],['12','away','high']]) {
  await new Promise(r=>setTimeout(r,1000));
  await evaluate(`document.getElementById('hour').value='${hour}';document.getElementById('yaw').value='${yaw}';document.getElementById('quality').value='${quality}';document.getElementById('load').click()`);
  let status='';for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,500));status=await evaluate(`document.getElementById('status')?.textContent||''`);if(status.includes('预览已就绪'))break;if(status.includes('失败')||status.includes('超时'))throw new Error(status);}
  if(!status.includes('预览已就绪'))throw new Error('Lab timeout');
  const before=await evaluate(`document.getElementById('view').contentWindow.__porco.qa.elapsed`);
  for(const version of ['previous','refined']) {
   await evaluate(`document.getElementById('layout').value='${version}';document.getElementById('layout').dispatchEvent(new Event('change'))`);await new Promise(r=>setTimeout(r,300));
   const state=await evaluate(`(()=>{const a=document.getElementById('view').contentWindow.__porco;return {elapsed:a.qa.elapsed,quality:a.world.quality,captures:a.world.sea.objectReflectionCaptures,resolution:a.world.sea.objectReflectionResolution,url:document.getElementById('fly').href};})()`);
   if(state.elapsed!==before)throw new Error('A/B moved simulation');
   if(!state.url.includes('puffreflection='+version))throw new Error('Wrong free flight URL');
   reports.push({hour,yaw,version,state});
   const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+hour+'-'+yaw+'-'+quality+'-'+version+'.png',Buffer.from(shot.data,'base64'));
  }
 }

 // Continuous steering with clouds and reflection updates, including a position jump.
 const flight=await evaluate(`(async()=>{const w=document.getElementById('view').contentWindow,a=w.__porco,c=a.renderer.domElement,b=c.getBoundingClientRect();const pointer=(type,x=0,y=0)=>c.dispatchEvent(new w.PointerEvent(type,{pointerId:41,pointerType:'mouse',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:b.left+b.width/2+x,clientY:b.top+b.height/2+y,bubbles:true}));const captures=a.world.sea.reflectionCaptures;for(let i=0;i<480;i++){if(i===90){pointer('pointerdown');pointer('pointermove',65,-20);}if(i===210)pointer('pointermove',-60,35);if(i===330)pointer('pointerup');a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}const end=a.game.pose(),count=a.world.sea.reflectionCaptures-captures;a.game.setPose(2000,60,-2000);a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();return {end,captures:count,afterJump:a.game.pose()};})()`);
 reports.push({flight});
 if(flight.captures<20||!Number.isFinite(flight.end.x))throw new Error('Dynamic reflection did not update');
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/after-flight-jump.png',Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify({root,reports,errors}));writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));if(errors.length)throw new Error('Browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
