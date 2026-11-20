/** Real WebGPU regression for the Nov 19 cloud shading seam.
 * Start Vite on 5173 and an isolated Chrome with WebGPU/CDP on 9223, then:
 * node scripts/cloud-shading-probe.mjs
 * Fixed production seed, camera, viewport and interior-cloud pixel region.
 * Screenshot checks intentionally exclude silhouettes, HUD and puff clouds.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const mode = 'cloud-shading';
const root = `artifacts/${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {width:570,height:510,deviceScaleFactor:1,mobile:false});
  const reports=[];
  for (const [name,debug,limit] of [['normals',6,16],['painted',0,8]]) {
    await send('Page.navigate',{url:'http://127.0.0.1:5173/?qa=frozen&tod=6&bgmotion=fixed&bglook=form&bgwrite=replace&pufflook=volume&sealook=painted&bgq=512&toon=0&dof=0&bgdbg='+debug});
    let ready=false;
    for(let i=0;i<180;i++) {
      await new Promise(r=>setTimeout(r,500));
      ready=await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);
      if(ready)break;
    }
    if(!ready)throw new Error('App boot timeout');
    await evaluate('(async()=>{for(let i=0;i<12;i++){__porco.qa.step(1,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone();}const a=__porco;const y=315*Math.PI/180;a.camera.lookAt(a.camera.position.x+Math.sin(y)*1000,a.camera.position.y+350,a.camera.position.z-Math.cos(y)*1000);a.camera.updateMatrixWorld();a.renderer.render(a.scene,a.camera);await a.renderer.backend.device.queue.onSubmittedWorkDone();})()');
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));
    // Seed 7's large cloud, well inside its silhouette: the Nov 19 defect was
    // a vertical normal/fog discontinuity here, with continuous hit depth.
    const metric=await evaluate(`(async()=>{
      const im=new Image(); im.src='data:image/png;base64,${shot.data}'; await im.decode();
      const c=document.createElement('canvas'); c.width=570; c.height=510;
      const ctx=c.getContext('2d'); ctx.drawImage(im,0,0);
      const d=ctx.getImageData(0,0,570,510).data;
      let maxJump=0;
      for(let y=140;y<260;y++) for(let x=290;x<360;x++) for(let k=0;k<3;k++)
        maxJump=Math.max(maxJump,Math.abs(d[(y*570+x)*4+k]-d[(y*570+x+1)*4+k]));
      const luma=(x,y)=>{const i=(y*570+x)*4;return .2126*d[i]+.7152*d[i+1]+.0722*d[i+2];};
      let lo=255,hi=0,curvature=0,count=0;
      for(let y=140;y<260;y++) for(let x=210;x<360;x++) {
        const v=luma(x,y);lo=Math.min(lo,v);hi=Math.max(hi,v);count++;
        curvature+=Math.abs(luma(x-1,y)+luma(x+1,y)+luma(x,y-1)+luma(x,y+1)-4*v);
      }
      return {maxAdjacentChannelJump:maxJump,litLumaRange:hi-lo,meanLitCurvature:curvature/count};
    })()`);
    reports.push({name,...metric,limit});
  }
  writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));
  console.log(JSON.stringify({root,reports,errors}));
  // The lit interior must have visible broad modelling without fine mottling.
  // Before the highlight ramp its luma range was only 0.79 / 255; after: 10.06.
  const painted=reports.find(r=>r.name==='painted');
  if(errors.length || reports.some(r=>r.maxAdjacentChannelJump>r.limit) ||
      painted.litLumaRange<5 || painted.litLumaRange>30 || painted.meanLitCurvature>0.6)
    throw new Error('Cloud shading regression: see report and screenshots');
} finally { await send('Page.close').catch(()=>{}); ws.close(); }
