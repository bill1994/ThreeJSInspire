/** Motion A/B and cloud-crossing captures. Start isolated Chrome on 9223 and Vite.
 * node scripts/motion-style-probe.mjs stage4-preview
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ablation';
const root = `artifacts/motion-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/motion-style-lab.html'});
 const reports=[];
 for(const [version,scenario,hour] of [['refined','turn','12'],['previous','turn','12'],['refined','cloud','12'],['refined','turn','0']]) {
  if(reports.length)await evaluate(`document.getElementById('layout').value='${version}';document.getElementById('scenario').value='${scenario}';document.getElementById('hour').value='${hour}';document.getElementById('load').click()`);
  const samples=[];let status='',lastShot=0;
  for(let i=0;i<300;i++){
   await new Promise(r=>setTimeout(r,250));
   status=await evaluate(`document.getElementById('status')?.textContent||''`);
   if(status.includes('失败')||status.includes('超时'))throw new Error(status);
   if(status.includes('播放中')||status.includes('演示完成')){
    const data=await evaluate(`(()=>{const a=document.getElementById('view').contentWindow.__porco;const l=a.scene.getObjectByName('porco_contrail_l'),r=a.scene.getObjectByName('porco_contrail_r'),s=a.scene.getObjectByName('porco_streaks');return {pose:a.game.pose(),opacity:l.material.opacity,wind:s.material.opacity,finite:[l,r,s].every(m=>Array.from(m.geometry.attributes.position.array).every(Number.isFinite)),count:l.geometry.drawRange.count};})()`);samples.push(data);
    const elapsed=Number(status.match(/([0-9]+\.[0-9]+) \/ 8/)?.[1]??8);
    if(elapsed>=lastShot+2){lastShot+=2;const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+version+'-'+scenario+'-'+hour+'-'+lastShot+'.png',Buffer.from(shot.data,'base64'));}
   }
   if(status.includes('演示完成'))break;
  }
  const actualHour=await evaluate(`new URL(document.getElementById('view').src).searchParams.get('tod')`);
  if(actualHour!==hour)throw new Error('Preview changed time during capture: '+actualHour+' expected '+hour);
  if(!status.includes('演示完成'))throw new Error('Demo did not finish: '+status);
  if(samples.some(s=>!s.finite))throw new Error('Non-finite motion geometry');
  if(scenario==='cloud'&&Math.min(...samples.map(s=>s.opacity))>.6)throw new Error('Cloud fixture did not enter cloud');
  reports.push({version,scenario,hour,status,samples});console.log(JSON.stringify({version,scenario,hour,minTrailOpacity:Math.min(...samples.map(s=>s.opacity)),end:samples.at(-1)?.pose}));
 }
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Motion browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
