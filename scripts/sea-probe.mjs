/** Local WebGPU acceptance probe. Start isolated Chrome on port 9223 and Vite.
 * node scripts/sea-probe.mjs ablation|matrix|horizon|flight|live|cloud|lab
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
const scenarios = mode === 'ablation'
  ? ['none', 'detail', 'fine', 'slope', 'reflection', 'road', 'foam'].map(diag => ({ name: diag, diag }))
  : [
    { name: 'sunset', sun: '12,7' }, { name: 'side', sun: '80,8' },
    { name: 'back', sun: '180,8' }, { name: 'highsun', sun: '12,45' },
    { name: 'low', sun: '12,7', pos: '0,18,0' },
    { name: 'high', sun: '12,7', pos: '0,220,0' },
    { name: 'lowtier', sun: '12,7', quality: false },
  ];
const reports = [];
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 448, height: 797, deviceScaleFactor: 1, mobile: false });
  const cases = mode === 'lab' ? [] : mode === 'ablation' ? scenarios.map(s => ({ ...s, look: 'legacy' }))
    : (['flight', 'live', 'cloud'].includes(mode) ? [{ name: mode, sun: '80,8' }] :
      mode === 'horizon' ? scenarios.filter(s=>['side','back','high'].includes(s.name)) : scenarios)
      .flatMap(s => ['legacy', 'painted'].map(look => ({ ...s, look })));
  for (const c of cases) {
    errors.length = 0;
    const p = new URLSearchParams({ qa: 'frozen', bglook: 'form', bgshape: 'legacy',
      bgwrite: 'replace', pufflook: 'volume', toon: '0', dof: '0', todspeed: '0',
      bgq: '512', sealook: c.look, seadiag: c.diag ?? 'none', sun: c.sun ?? '12,7', pos: c.pos ?? '0,70,0' });
    if (mode === 'live') p.delete('qa');
    await send('Page.navigate', { url: `http://127.0.0.1:5173/?${p}` });
    let ready = false;
    for (let i = 0; i < 180; i++) {
      await new Promise(r => setTimeout(r, 500));
      ready = await evaluate('Boolean(window.__porco?.qa)').catch(()=>false);
      if (ready) break;
    }
    if (!ready) throw new Error('App failed to boot: ' + JSON.stringify(errors));
    await evaluate(`document.querySelectorAll('.porco-hud').forEach(e=>e.style.visibility='hidden');
      if(!__porco.world?.sea || !__porco.world.clouds || !__porco.post) throw new Error('Incomplete scene');
      __porco.qa.setQuality(${c.quality !== false});`);
    if (mode === 'live') {
      // Real rAF flight, not a fixed-dt substitute for FPS. Include turn/climb
      // then reverse turn/dive; the flight model changes speed with pitch.
      const snapshots=[];
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:224,y:400,button:'left',clickCount:1});
      for(let i=0;i<6;i++) {
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:i<3?260:185,y:i<3?375:430,button:'left',buttons:1});
        await new Promise(r=>setTimeout(r,5000));
        snapshots.push(await evaluate('({scene:__porco.qa.describe(),stats:__porco.qa.frameStats(),pose:__porco.game.pose()})'));
        const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        writeFileSync(`${root}/${c.look}-${i}.png`,Buffer.from(shot.data,'base64'));
      }
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:224,y:400,button:'left',clickCount:1});
      reports.push({name:c.look,snapshots,errors:[...errors]});
      writeFileSync(`${root}/report.json`,JSON.stringify(reports,null,2));
      console.log(JSON.stringify({name:c.look,root,snapshots,errors:errors.length}));
      if(errors.length) throw new Error('Live browser errors');
      continue;
    }
    for (let i = 0; i < 30; i++) await evaluate(`(async()=>{
      __porco.qa.step(10,1/60); await __porco.renderer.backend.device.queue.onSubmittedWorkDone(); })()`);
    const name = `${c.name}-${c.look}`;
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`${root}/${name}.png`, Buffer.from(shot.data, 'base64'));
    const metadata = await evaluate(`(async()=>{
      const device = __porco.renderer.backend.device;
      const adapter = await navigator.gpu.requestAdapter();
      const info = adapter.info;
      const samples=[];
      for(let i=0;i<40;i++) { const t=performance.now(); __porco.qa.step(1,1/60);
        await device.queue.onSubmittedWorkDone(); if(i>=10) samples.push(performance.now()-t); }
      samples.sort((a,b)=>a-b);
      return { scene:__porco.qa.describe(), browser:navigator.userAgent,
        gpu: {vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description},
        warmup:10,samples:30,p50:samples[14],p95:samples[28], allMs:samples };
    })()`);
    if (mode === 'cloud') {
      metadata.cloud = [];
      for (const z of [3.5, 1.25, 0, -0.85, -1.5, -3.5]) {
        metadata.cloud.push(await evaluate(`(async()=>{
          const a=__porco, field=a.scene.getObjectByName('puff-field');
          const cloud=field.children.find(c=>c.userData.variant==='scraps')??field.children[0];
          field.children.forEach(c=>c.visible=c===cloud);
          cloud.position.set(0,120,0);cloud.material.userData.edgeFade.value=1;
          const s=cloud.userData.blobSize;
          a.camera.position.set(0,120,${z}*s.halfW);a.camera.lookAt(0,110,${z}*s.halfW-100);a.camera.updateMatrixWorld();
          const plane=a.scene.getObjectByName('porco_root');plane.position.set(0,118,a.camera.position.z-15);
          a.scene.getObjectByName('sky_sunset_tsl')?.position.copy(a.camera.position);
          const {cloudProximity01}=await import('/src/in-cloud.ts');
          const prox=cloudProximity01(a.camera.position,[{x:0,y:120,z:0,halfW:s.halfW,halfH:s.halfH}]);
          a.world.setInterior(prox,a.camera.position);
          a.world.sea.update(a.camera.position,a.camera.fov*Math.PI/180/a.renderer.domElement.height,6,0.5);
          a.post.render();await a.renderer.backend.device.queue.onSubmittedWorkDone();
          return {relativeZ:${z},proximity:prox,variant:cloud.userData.variant,size:s};
        })()`));
        const s=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        writeFileSync(`${root}/${name}-${z}.png`,Buffer.from(s.data,'base64'));
      }
    }
    if (mode === 'flight') {
      // 30 simulated seconds, with turn and acceleration/deceleration inputs.
      await send('Input.dispatchMouseEvent', {type:'mousePressed',x:224,y:400,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:275,y:380,button:'left',buttons:1});
      const dynamic = [];
      for(let i=0;i<90;i++) {
        if(i===30) await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:170,y:420,button:'left',buttons:1});
        if(i===60) await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:224,y:400,button:'left',clickCount:1});
        await evaluate('(async()=>{__porco.qa.step(20,1/60);await __porco.renderer.backend.device.queue.onSubmittedWorkDone()})()');
        if(i%10===0) {
          dynamic.push(await evaluate('__porco.qa.describe()'));
          const s = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
          writeFileSync(`${root}/${name}-${i}.png`,Buffer.from(s.data,'base64'));
        }
      }
      metadata.dynamic = dynamic;
    }
    reports.push({ name, url: `/?${p}`, ...metadata, errors: [...errors] });
    writeFileSync(`${root}/report.json`, JSON.stringify(reports, null, 2));
    console.log(JSON.stringify({ name, root, p50: metadata.p50, p95: metadata.p95, gpu: metadata.gpu, errors: errors.length }));
    if(errors.length) throw new Error('Browser errors: see report.json');
  }
  if(mode === 'lab') {
    await send('Emulation.setDeviceMetricsOverride',{width:1200,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'http://127.0.0.1:5173/sea-lab.html'});
    for(const look of ['painted','legacy']) {
      if(look==='legacy') await evaluate("document.querySelector('#look').value='legacy';document.querySelector('#quality').value='low';document.querySelector('#load').click()");
      let state;
      for(let i=0;i<180;i++) {
        await new Promise(r=>setTimeout(r,500));
        state=await evaluate("document.querySelector('#status')?.textContent").catch(()=>null);
        if(state?.startsWith('固定 300 帧'))break;
      }
      if(!state?.startsWith('固定 300 帧'))throw new Error('Lab failed: '+state);
      reports.push({look,state,errors:[...errors]});
      console.log(JSON.stringify({look,state}));
    }
    writeFileSync(`${root}/report.json`,JSON.stringify(reports,null,2));
    if(errors.length)throw new Error('Lab browser errors');
  }
} finally { await send('Page.close').catch(()=>{}); ws.close(); }
