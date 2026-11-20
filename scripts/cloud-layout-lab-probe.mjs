/** Local WebGPU acceptance probe. Start isolated Chrome on port 9223 and Vite.
 * node scripts/cloud-reflection-lab-probe.mjs stage5-lab
 * No browser automation dependency; CDP uses Node's WebSocket and fetch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ablation';
const root = `artifacts/cloud-layout-sky-audit-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
 await send('Page.navigate',{url:'http://127.0.0.1:5173/cloud-layout-lab.html'});
 const reports=[];
 for(const [hour,yaw] of [['12','flight'],['12','90'],['0','180']]){
  await new Promise(r=>setTimeout(r,1000));
  await evaluate(`document.getElementById('hour').value='${hour}';document.getElementById('yaw').value='${yaw}';document.getElementById('load').click()`);
  let status='';for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,500));status=await evaluate(`document.getElementById('status').textContent`);if(status.includes('预览已就绪'))break;if(status.includes('失败')||status.includes('超时'))throw new Error(status);}
  if(!status.includes('预览已就绪'))throw new Error('Preview timeout');
  reports.push({hour,yaw,status});const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/'+hour+'-'+yaw+'.png',Buffer.from(shot.data,'base64'));
 }
 // Approach a real cloud bank over 20 simulation seconds to inspect size/depth.
 await evaluate(`(async()=>{const a=document.getElementById('view').contentWindow.__porco;a.qa.setTod(12);for(let i=0;i<400;i++){a.qa.step(1,.05);await a.renderer.backend.device.queue.onSubmittedWorkDone();}})()`);
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(root+'/flight-20s.png',Buffer.from(shot.data,'base64'));
 writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));console.log(JSON.stringify({root,errors}));if(errors.length)throw new Error('Browser errors');
}finally{ws.close();await fetch('http://127.0.0.1:9223/json/close/'+target.id).catch(()=>{});}
