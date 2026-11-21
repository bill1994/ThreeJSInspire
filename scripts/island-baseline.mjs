/** Start Vite and an isolated Chromium with a localhost debugging port first.
 * node scripts/island-baseline.mjs [Vite origin] [debugging origin]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const cdp = process.argv[3] ?? 'http://127.0.0.1:9223';
const root = 'artifacts/island-baseline-' + new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(root, { recursive: true });
const target = await (await fetch(cdp + "/json/new?about:blank", { method: 'PUT' })).json();
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function openScene(query) {
  await send('Page.navigate', {url: origin + '/?' + query});
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (await evaluate('Boolean(window.__porco?.qa)').catch(() => false)) return;
    const status = await evaluate("document.querySelector('#boot-status')?.textContent").catch(() => '');
    if (status?.includes('unavailable')) throw new Error(status);
  }
  throw new Error('Scene boot timeout');
}
const reports = [], effects = [];
function save() {
  writeFileSync(root + '/report.json', JSON.stringify({origin, reports, effects, errors}, null, 2));
}
function summarize(values) {
  values.sort((a,b) => a-b);
  return {count: values.length, mean: values.reduce((s,x) => s+x,0)/values.length,
    p95: values[Math.ceil(values.length*.95)-1], p99: values[Math.ceil(values.length*.99)-1],
    max: values.at(-1), over50: values.filter(x => x > 50).length};
}
try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:570,height:800,deviceScaleFactor:1,mobile:false});
  const query = 'land=off&bench=1&tod=12&todspeed=0&alt=6';
  await openScene(query);
  const device = await evaluate(`(async () => {
    const a = __porco, info = a.renderer.backend.device.adapterInfo;
    const {waterReflectables}=await import('/src/sea/object-reflection.ts');
    return {browser:navigator.userAgent, gpu:[info.vendor,info.architecture,info.description],
      timestampQuery:a.renderer.backend.device.features.has('timestamp-query'),
      sea:!!a.world.sea, cloudBlobs:a.world.blobs.length, post:!!a.post, game:!!a.game,
      reflectedMeshes:waterReflectables(a.scene).filter(o=>o.isMesh).length,
      firstReadyMs:performance.now(), state:a.qa.describe()};
  })()`);
  reports.push(device);
  console.log(root, JSON.stringify(device));
  if (!device.sea || !device.post || !device.cloudBlobs || !device.game) throw new Error('Incomplete baseline scene');
  await sleep(8000);
  const routes = process.argv.includes('--effects-only') ? [] : ['day-low','day-turn','cloud-pass','night'];
  for (const name of routes) {
    if (name === 'night') await evaluate('__porco.qa.setTod(23)');
    if (name === 'cloud-pass') await evaluate(`(() => {
      const a=__porco, b=a.world.blobs.find(b=>b.y>=10 && b.y<=230);
      a.game.setPose(b.x,b.y,b.z);
    })()`);
    if (name === 'day-turn') {
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:280,y:460,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:360,y:460,button:'left',buttons:1});
    }
    const sample = await evaluate(`new Promise(resolve=>{
      const a=__porco, dt=[], cpu=[], draws=[], start=performance.now();
      let last=null, cloudFrames=0; const initial=a.qa.describe();
      const captures=a.world.sea.objectReflectionCaptures;
      function tick(t) {
        if(last!==null){dt.push(t-last); cpu.push(a.qa.cpuSubmitMs); draws.push(a.renderer.info.render.drawCalls);}
        if(a.qa.cloudProximity>=.999) cloudFrames++;
        last=t;
        if(t-start<45500) requestAnimationFrame(tick);
        else resolve({dt,cpu,draws,initial,final:a.qa.describe(),cloudFrames,
          captures:a.world.sea.objectReflectionCaptures-captures,resolution:a.world.sea.objectReflectionResolution});
      }
      requestAnimationFrame(tick);
    })`);
    if (name === 'day-turn') await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:360,y:460,button:'left',clickCount:1});
    for(const key of ['dt','cpu','draws']) sample[key]=summarize(sample[key]);
    reports.push({name,...sample});
    save(); console.log(name,JSON.stringify(sample.dt), 'cloud',sample.cloudFrames);
  }
  // Equal fixed-step flight and quality for each paired diagnostic. Queue wait
  // includes JS submission and GPU completion and is separate from live rAF.
  for (const flag of ['', 'objectreflection=off', 'post=0','puff=0','bg=0','sea=0']) {
    await openScene(query+'&qa=frozen&'+flag);
    const sample = await evaluate(`(async()=>{
      const a=__porco, times=[], render=[], compute=[];
      const backend=a.renderer.backend;
      backend.trackTimestamp=backend.device.features.has('timestamp-query');
      a.qa.setQuality(false);
      for(let i=0;i<72;i++){
        const start=performance.now();
        a.qa.step(1,1/60);
        await a.renderer.backend.device.queue.onSubmittedWorkDone();
        const queueMs=performance.now()-start;
        const passMs=backend.trackTimestamp ? await Promise.all([
          a.renderer.resolveTimestampsAsync('render'),a.renderer.resolveTimestampsAsync('compute')
        ]) : [];
        if(i>=24) {
          times.push(queueMs);
          if(Number.isFinite(passMs[0])) render.push(passMs[0]);
          if(Number.isFinite(passMs[1])) compute.push(passMs[1]);
        }
      }
      return {times,render,compute,state:a.qa.describe()};
    })()`);
    effects.push({flag,queueMs:summarize(sample.times),
      gpuRenderMs:sample.render.length ? summarize(sample.render) : null,
      gpuComputeMs:sample.compute.length ? summarize(sample.compute) : null,state:sample.state});
    save(); console.log(flag || 'all',JSON.stringify(effects.at(-1).queueMs));
  }
  await openScene('land=single&tod=17&todspeed=0&alt=60');
  await sleep(2500);
  const experiment=await evaluate('__porco.qa.describe().islandExperiment');
  if (!experiment.requested || experiment.seed !== 20261120) throw new Error('Single island entry unavailable');
  const image=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(root+'/preview.png',Buffer.from(image.data,'base64'));
  if (errors.length) throw new Error('See browser errors in ' + root + '/report.json');
} finally {
  save();
  ws.close();
  await fetch(cdp+'/json/close/'+target.id).catch(()=>{});
}
