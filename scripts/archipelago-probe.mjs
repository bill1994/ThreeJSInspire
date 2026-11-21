/** Exercise streamed islands using an isolated local Chromium target. */
import { mkdirSync, writeFileSync } from 'node:fs';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const cdp = process.argv[3] ?? 'http://127.0.0.1:9223';
const root = 'artifacts/archipelago-' + new Date().toISOString().replace(/[:.]/g, '-');
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
async function snap(name) {
  const shot=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(root+'/'+name+'.png',Buffer.from(shot.data,'base64'));
}
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:570,height:800,deviceScaleFactor:1,mobile:false});
  console.log(root);
  const live = process.argv.includes('--live');
  const approach = process.argv.includes('--approach');
  const query='tod=12&todspeed=0&bench=1'+(live?'':'&qa=frozen');
  const aerial = process.argv.includes('--aerial');
  const meadow = aerial || process.argv.includes('--meadow');
  if (!meadow) await openScene('land='+(live||approach?'archipelago':'cluster')+'&'+query+(approach?'&pos=85,115,275':''));
  if(meadow){
    for(const look of (aerial?['meadow','paint']:['previous','meadow'])){
      await openScene('land=archipelago&pass='+(aerial?'aerial':'meadow')+'&qa=frozen&tod=12&todspeed=0&grasslook='+look);
      await evaluate('__porco.qa.setQuality(true)');
      const folder=root+'/'+look;
      mkdirSync(folder);
      for(let frame=0;frame<160;frame++){
        await evaluate(`(async()=>{const a=__porco;
          for(let i=0;i<4;i++){a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone();}
        })()`);
        const shot=await send('Page.captureScreenshot',{format:'png',clip:{x:60,y:0,width:450,height:800,scale:1}});
        writeFileSync(folder+'/'+String(frame).padStart(3,'0')+'.png',Buffer.from(shot.data,'base64'));
      }
      reports.push({look,state:await evaluate('__porco.qa.describe()')});save();
      if(aerial && look==='paint'){
        for(const hour of [17,23]){
          await evaluate(`(async()=>{const a=__porco;a.qa.setTod(${hour});a.qa.step(1,1/60);await a.renderer.backend.device.queue.onSubmittedWorkDone()})()`);
          await snap('hour-'+hour);
        }
      }
    }
  } else if(approach){
    await evaluate('__porco.qa.setQuality(true);__porco.qa.step(3,1/60)');
    await snap('approach');
    const measurements=await evaluate(`(async()=>{
      const a=__porco, queue=a.renderer.backend.device.queue;
      const write=queue.writeBuffer.bind(queue), texture=queue.writeTexture.bind(queue);
      let bufferBytes=0,textureBytes=0;
      const buffers=[],textures=[];
      queue.writeBuffer=(target,offset,data,from=0,size)=>{
        const unit=data.BYTES_PER_ELEMENT??1;
        bufferBytes+=size===undefined?data.byteLength-from*unit:size*unit;
        write(target,offset,data,from,size);
      };
      queue.writeTexture=(target,data,layout,size)=>{
        textureBytes+=data.byteLength-(layout.offset??0);texture(target,data,layout,size);
      };
      try {
        for(let i=0;i<780;i++){
          bufferBytes=textureBytes=0;a.qa.step(1,1/60);
          await queue.onSubmittedWorkDone();
          buffers.push(bufferBytes);textures.push(textureBytes);
        }
      } finally {queue.writeBuffer=write;queue.writeTexture=texture;}
      return {buffers,textures,state:a.qa.describe(),flora:a.archipelago.flora};
    })()`);
    for(const k of ['buffers','textures'])measurements[k]=summary(measurements[k]);
    reports.push(measurements);save();
  } else if(live){
    await evaluate('__porco.qa.setQuality(true)');
    await sleep(6000);
    for(let j=0;j<3;j++){
      const report=await evaluate(`new Promise(resolve=>{
        let start=0,last=0;const dt=[],cpu=[],draws=[];
        function tick(t){
          if(last){dt.push(t-last);cpu.push(__porco.qa.cpuSubmitMs);draws.push(__porco.renderer.info.render.drawCalls);}
          if(!start)start=t;last=t;
          if(t-start<60500)requestAnimationFrame(tick);
          else resolve({dt,cpu,draws,state:__porco.qa.describe()});
        }
        requestAnimationFrame(tick);
      })`);
      for(const k of ['dt','cpu','draws'])report[k]=summary(report[k]);
      reports.push(report);save();console.log(j,report.dt,report.state.archipelago);
    }
  } else {
    reports.push({fixture:await evaluate('__porco.archipelago.inventory()')});
    await openScene('land=archipelago&'+query);
    await evaluate('__porco.qa.setQuality(true);__porco.qa.step(30,1/60)');
    await snap('approach');
    const navigation=await evaluate(`(async()=>{
      const a=__porco.archipelago;
      const origin=a.inventory().find(s=>s.id==='0,0');
      async function visit(x,z){
        let i=0;
        do{
          const p={x,y:70,z};a.update(i/60,p,p,true);
          await new Promise(r=>setTimeout(r,3));
          if(++i>900)throw Error('Queue did not drain');
        }while(a.stats.pending);
        return {stats:{...a.stats},items:a.inventory()};
      }
      const away=await visit(12000,10000), home=await visit(0,0);
      const restored=home.items.find(s=>s.id==='0,0');
      if(away.items.some(s=>s.id==='0,0') || JSON.stringify(origin)!==JSON.stringify(restored))throw Error('Revisit mismatch');
      const ring=Array.from({length:4},(_,i)=>home.items.filter(s=>{
        const angle=Math.atan2(s.x,-s.z)-Math.PI*i/2;
        return Math.cos(angle)>.86 && Math.hypot(s.x,s.z)-230<1800;
      }).length);
      if(ring.includes(0))throw Error('Empty quadrant');
      return {origin,restored,away:away.stats,home:home.stats,ring};
    })()`);
    reports.push({navigation});save();
    // Rotate the existing camera immediately, keeping the streaming centre fixed.
    for (const label of ['back','forward']) {
      await evaluate(`(async()=>{const a=__porco;a.camera.rotateY(Math.PI);a.camera.updateMatrixWorld();a.world.sea.setObjectReflection(true);a.world.sea.updateObjectReflection(a.scene,a.camera,a.qa.describe().elapsed);a.post.render();await a.renderer.backend.device.queue.onSubmittedWorkDone();})()`);
      await snap(label);
    }
    for(const enabled of [false,true]){
      const metrics=await evaluate(`(async()=>{
        const a=__porco,b=a.renderer.backend, samples={cpu:[],gpu:[],draws:[]};
        a.game.setPose(0,22,-62);
        a.archipelago.setReflection(${enabled});
        b.trackTimestamp=b.device.features.has('timestamp-query');
        for(let i=0;i<110;i++){
          a.game.setPose(0,22,-62);
          const start=performance.now();a.qa.step(1,1/60);const cpu=performance.now()-start;
          const draw=a.renderer.info.render.drawCalls;await b.device.queue.onSubmittedWorkDone();
          const gpu=b.trackTimestamp?await a.renderer.resolveTimestampsAsync('render'):null;
          if(i>29){samples.cpu.push(cpu);samples.draws.push(draw);if(gpu!=null)samples.gpu.push(gpu);}
        }
        return {...samples,state:a.qa.describe()};
      })()`);
      for(const key of ['cpu','draws','gpu'])metrics[key]=summary(metrics[key]);
      reports.push({enabled,...metrics});save();console.log(enabled,metrics.gpu);
    }
    const captureOnly=await evaluate(`(async()=>{
      const a=__porco,b=a.renderer.backend,sea=a.world.sea;
      const rows=[{cpu:[],gpu:[],draws:[]},{cpu:[],gpu:[],draws:[]}];
      for(let i=0;i<120;i++){
        const on=i%2;
        a.archipelago.setReflection(Boolean(on));sea.setObjectReflection(true);
        const calls=a.renderer.info.render.drawCalls,start=performance.now();
        sea.updateObjectReflection(a.scene,a.camera,a.qa.elapsed);
        const cpu=performance.now()-start,draws=a.renderer.info.render.drawCalls-calls;
        await b.device.queue.onSubmittedWorkDone();
        const gpu=b.trackTimestamp?await a.renderer.resolveTimestampsAsync('render'):null;
        if(i>=20){rows[on].cpu.push(cpu);rows[on].draws.push(draws);if(gpu!=null)rows[on].gpu.push(gpu);}
      }
      return rows;
    })()`);
    for(const row of captureOnly) for(const key of ['cpu','gpu','draws'])row[key]=summary(row[key]);
    reports.push({captureOnly});save();
    // Matched simulation time, projection and lighting on the exact same pixels.
    for(const enabled of [true,false]){
      await evaluate(`(async()=>{const a=__porco;a.archipelago.setReflection(${enabled});a.world.sea.setObjectReflection(true);a.world.sea.updateObjectReflection(a.scene,a.camera,a.qa.describe().elapsed);a.post.render();await a.renderer.backend.device.queue.onSubmittedWorkDone()})()`);
      await snap(enabled?'shore-on':'shore-off');
    }
    await evaluate('__porco.qa.setTod(17.5);__porco.archipelago.setReflection(true);__porco.qa.step(5,1/60)');
    await snap('sunset');
    // Browser-side fault injection is scoped to this disposable probe target.
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`{
      const RealWorker=window.Worker;
      window.Worker=class extends RealWorker {
        postMessage(job,...args){
          if(job?.key==='0,0'){
            setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:{error:'probe failure'}})),0);
          }
          else super.postMessage(job,...args);
        }
      };
    }`});
    await openScene('land=cluster&'+query);
    const failure=await evaluate('({...__porco.archipelago.stats})');
    if(failure.exhausted!==1 || failure.pending || failure.resident!==3)
      throw Error('Failed-worker recovery mismatch '+JSON.stringify(failure));
    reports.push({failure});save();
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.Worker=class {constructor(){throw Error('probe worker unavailable')}};`});
    await openScene('land=cluster&'+query);
    const fallback=await evaluate('({...__porco.archipelago.stats})');
    if(fallback.worker!=='fallback' || fallback.resident!==4 || fallback.pending)throw Error('Fallback did not drain');
    reports.push({fallback});save();
  }
  if(errors.length)throw Error('See browser errors in '+root);
}finally{save();ws.close();await fetch(cdp+'/json/close/'+target.id).catch(()=>{});}
