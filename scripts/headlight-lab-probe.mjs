/** Aircraft headlight A/B captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/headlight-lab-probe.mjs stage6-lab
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
 await send('Emulation.setDeviceMetricsOverride',{width:1100,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:5173/headlight-lab.html'});
 const reports=[];
 for(const [scenario,hour,quality,viewpoint] of [['cruise','0','high','side'],['low','0','low','chase'],['cloud','0','high','chase'],['cruise','12','high','chase']]) {
  await new Promise(r=>setTimeout(r,1000));
  await evaluate(`document.getElementById('scenario').value='${scenario}';document.getElementById('hour').value='${hour}';document.getElementById('quality').value='${quality}';document.getElementById('viewpoint').value='${viewpoint}';document.getElementById('load').click()`);
  let status='';for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,500));status=await evaluate(`document.getElementById('status')?.textContent||''`);if(status.includes('预览已就绪'))break;if(status.includes('失败')||status.includes('超时'))throw new Error(status);}
  if(!status.includes('预览已就绪'))throw new Error('Lab timeout');
  const before=await evaluate(`document.getElementById('view').contentWindow.__porco.qa.elapsed`);
  for(const mode of ['off','auto']) {
   await evaluate(`document.getElementById('mode').value='${mode}';document.getElementById('mode').dispatchEvent(new Event('change'))`);await new Promise(r=>setTimeout(r,250));
   const state=await evaluate(`(()=>{const a=document.getElementById('view').contentWindow.__porco;return {elapsed:a.qa.elapsed,strength:a.world.headlight.uniforms.strength.value,quality:a.world.quality,url:document.getElementById('fly').href};})()`);
   if(state.elapsed!==before||!state.url.includes('headlight='+mode))throw new Error('Invalid frozen comparison');
   if(mode==='auto'&&state.strength!==(hour==='12'?0:1))throw new Error('Auto switch failed');
   reports.push({scenario,hour,mode,state});
   const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+scenario+'-'+hour+'-'+mode+'.png',Buffer.from(shot.data,'base64'));
  }
 }
 // Night flight through a fixture cloud and a complete steering sequence.
 await evaluate(`(async()=>{document.getElementById('hour').value='0';document.getElementById('status').textContent='动态飞行检查 · 夜间';const a=document.getElementById('view').contentWindow.__porco;a.qa.setTod(0);for(let i=0;i<48;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}const p=a.game.pose(),c=a.scene.getObjectByName('puff-field').children[0];c.position.set(p.x,p.y+10,p.z-85);c.material.userData.edgeFade.value=1;})()`);
 for(let block=0;block<4;block++) {
  const data=await evaluate(`(async()=>{const w=document.getElementById('view').contentWindow,a=w.__porco,c=a.renderer.domElement,b=c.getBoundingClientRect(),u=a.world.headlight.uniforms;const pointer=(type,x=0,y=0)=>c.dispatchEvent(new w.PointerEvent(type,{pointerId:41,pointerType:'mouse',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:b.left+b.width/2+x,clientY:b.top+b.height/2+y,bubbles:true}));let maxError=0;for(let j=0;j<120;j++){const i=${block}*120+j;if(i===90){pointer('pointerdown');pointer('pointermove',65,-20);}if(i===210)pointer('pointermove',-60,35);if(i===330)pointer('pointerup');a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();const expected=u.direction.value.clone().set(0,Math.sin(-6*Math.PI/180),-Math.cos(-6*Math.PI/180)).transformDirection(a.scene.getObjectByName('porco_roll').matrixWorld);maxError=Math.max(maxError,expected.distanceTo(u.direction.value));}return {maxError,pose:a.game.pose(),strength:u.strength.value,direction:u.direction.value.toArray()};})()`);
  if(data.maxError>1e-6||data.strength!==1)throw new Error('Headlight did not follow aircraft');reports.push({block,...data});
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/flight-'+block+'.png',Buffer.from(shot.data,'base64'));
 }
 await evaluate(`(async()=>{const a=document.getElementById('view').contentWindow.__porco,u=a.world.headlight.uniforms;a.camera.position.copy(u.position.value).addScaledVector(u.direction.value,25);a.camera.lookAt(u.position.value.clone().addScaledVector(u.direction.value,160));a.camera.updateMatrixWorld();a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/inside-beam.png',Buffer.from(shot.data,'base64'));
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Headlight browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
