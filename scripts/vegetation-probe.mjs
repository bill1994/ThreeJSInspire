/** Measure the three fixed island passes. Options: --views, --live. */
import { mkdirSync, writeFileSync } from 'node:fs';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const cdp = process.argv[3] ?? 'http://127.0.0.1:9223';
const root = 'artifacts/vegetation-' + new Date().toISOString().replace(/[:.]/g, '-');
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
const summary = values => {
  values.sort((a,b)=>a-b);
  const n=values.length;
  return {n,mean:values.reduce((acc,v)=>acc+v,0)/n,p95:values[Math.ceil(n*.95)-1],
    p99:values[Math.ceil(n*.99)-1],max:values[n-1],over50:values.filter(ms=>ms>50).length};
};
const reports=[];
const save=()=>writeFileSync(root+'/report.json',JSON.stringify({reports,errors},null,2));
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:570,height:800,deviceScaleFactor:1,mobile:false});
  console.log(root);
  const live=process.argv.includes('--live');
  const quick=process.argv.includes('--views');
  for(const pass of (live?['grass']:['grass','canopy','sand'])){
    for(const tier of (live || quick?['high']:['high','low'])){
      for(const flora of (live || quick?[true]:[false,true])){
        const positions={grass:'44,13,-302',canopy:'133,57,-256',sand:'202,10,-277'};
        const query='land=single&tod=12&todspeed=0&bench=1&pos='+positions[pass]+(flora?'&pass='+pass:'')+(live?'':'&qa=frozen');
        await openScene(query);
        await evaluate(`(()=>{
          const a=__porco;
          if(!a.world?.sea || !a.post || !a.island || !!a.island.flora!==${flora})throw Error('Incomplete scene');
          a.qa.setQuality(${tier==='high'});
        })()`);
        if(live){
          await sleep(6500);
          await evaluate('__porco.game.setPose(-124,36,-380)');
          await send('Input.dispatchMouseEvent',{type:'mousePressed',x:280,y:500,button:'left',clickCount:1});
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:324,y:500,button:'left',buttons:1});
          for(let j=0;j<3;j++){
            const r=await evaluate(`new Promise(resolve=>{
              let start=0,last=0;const dt=[],cpu=[],draws=[];
              function tick(t){
                if(last){dt.push(t-last);cpu.push(__porco.qa.cpuSubmitMs);draws.push(__porco.renderer.info.render.drawCalls);}
                if(!start)start=t;last=t;
                if(t-start<60500)requestAnimationFrame(tick);
                else resolve({dt,cpu,draws,state:__porco.qa.describe()});
              }
              requestAnimationFrame(tick);
            })`);
            for(const k of ['dt','cpu','draws'])r[k]=summary(r[k]);
            reports.push({pass,tier,flora,...r});save();console.log(j,r.dt);
          }
        }else{
          const paths={grass:135,canopy:170,sand:126};
          const captureAt=paths[pass];
          for(const part of [0,1]){
            const r=await evaluate(`(async()=>{
              const a=__porco,b=a.renderer.backend,draw=[],cpu=[],gpu=[],uploads=[];
              const queue=b.device.queue,write=queue.writeBuffer.bind(queue);
              let submitted=0,firstFrameBytes=0;
              queue.writeBuffer=(buffer,offset,data,from=0,size)=>{
                const unit=data.BYTES_PER_ELEMENT ?? 1;
                submitted+=size===undefined ? data.byteLength-from*unit : size*unit;
                write(buffer,offset,data,from,size);
              };
              b.trackTimestamp=b.device.features.has('timestamp-query');
              let peakActive=0,peakAlive=0,burst=0;
              for(let i=0;i<${part===0?captureAt:240-captureAt};i++){
                submitted=0;
                const t=performance.now();a.qa.step(1,1/60);const ms=performance.now()-t;
                const calls=a.renderer.info.render.drawCalls;
                await b.device.queue.onSubmittedWorkDone();
                const ts=b.trackTimestamp ? await Promise.all([a.renderer.resolveTimestampsAsync('render'),a.renderer.resolveTimestampsAsync('compute')]) : [];
                if(i===0)firstFrameBytes=submitted;
                if(i>=24 || ${part===1}){cpu.push(ms);draw.push(calls);uploads.push(submitted);if(Number.isFinite(ts[0]))gpu.push(ts[0]);}
                const v=a.island.flora?.stats;
                if(v){peakActive=Math.max(peakActive,v.activeClumps);peakAlive=Math.max(peakAlive,v.debris.alive);burst=Math.max(burst,v.debris.uploadedBytes);}
              }
              queue.writeBuffer=write;
              return {cpu,gpu,draw,uploads,firstFrameBytes,peakActive,peakAlive,burst,state:a.qa.describe()};
            })()`);
            for(const k of ['cpu','gpu','draw','uploads'])r[k]=summary(r[k]);
            reports.push({pass,tier,flora,part,...r});save();
            if(flora && part===0){
              const shot=await send('Page.captureScreenshot',{format:'png'});
              writeFileSync(root+'/'+pass+'-'+tier+'.png',Buffer.from(shot.data,'base64'));
              if(pass!=='sand'){
                await evaluate(`(async()=>{__porco.island.flora.setWakeEnabled(false);__porco.post.render();await __porco.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
                const wind=await send('Page.captureScreenshot',{format:'png'});
                writeFileSync(root+'/'+pass+'-'+tier+'-wind.png',Buffer.from(wind.data,'base64'));
                await evaluate('__porco.island.flora.setWakeEnabled(true)');
              }
            }
            if(part===1)console.log(pass,tier,flora,r.state.vegetation?.debris,r.gpu.mean);
          }
        }
      }
    }
  }
  if(errors.length) throw Error('See browser errors in '+root);
}finally{save();ws.close();await fetch(cdp+'/json/close/'+target.id).catch(()=>{});}
