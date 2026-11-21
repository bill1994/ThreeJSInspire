import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buffers, generate, GRASS_TILE, MASK_SIDE, type Job, type Packet } from './archipelago-data';
import { gridCol, gridRow, islandAtCell, meshHeight, ORIGIN_Z, PITCH, shore, surface, type IslandSpec } from './archipelago-layout';
import { smooth } from './terrain';
import { fieldGeometry } from './field-cover';
import { plantIsland, type IslandTree } from './vegetation';
import type { Point } from './airflow';

const LAND_LIMIT = 40, TILE_LIMIT = 128, PRELOAD = 2350;
type IslandPacket = Extract<Packet, {kind:'island'}>;
type Resident = {
  spec: IslandSpec; data: IslandPacket; root: THREE.Group; reflection: THREE.Group;
  proxyTrees: THREE.InstancedMesh; farTrees: THREE.InstancedMesh; bytes: number;
};
function geometry(data: IslandPacket['full']) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(data.color, 3, true));
  g.setIndex(new THREE.BufferAttribute(data.index, 1));
  g.computeBoundingSphere();
  return g;
}

export async function mountArchipelago(scene: THREE.Scene, seed: number, fixed: boolean, start = {x:0,z:0}, meadow = true, fieldSun?: THREE.Vector3) {
  const {MeshLambertNodeMaterial} = await import('three/webgpu');
  const T = await import('three/tsl');
  const fill = T.uniform(new THREE.Color()), haze = T.uniform(new THREE.Color());
  const air = T.smoothstep(100, 1600, T.positionWorld.distance(T.cameraPosition)).mul(0.32);
  const ambient = T.diffuseColor.rgb.mul(fill).add(haze.mul(air));
  const ground = new MeshLambertNodeMaterial({vertexColors:true, fog:false});
  const leaves = new MeshLambertNodeMaterial({fog:false}), bark = new MeshLambertNodeMaterial({color:'#77583d', fog:false});
  const distant = new MeshLambertNodeMaterial({vertexColors:true, fog:false});
  for (const mat of [ground, leaves, bark, distant]) Object.assign(mat, {emissiveNode:ambient});
  const reflectedGround = ground.clone(), reflectedTrees = distant.clone();
  const reflectOpacity = T.smoothstep(420, 625, T.positionWorld.xz.distance(T.cameraPosition.xz)).oneMinus().mul(0.43);
  for (const mat of [reflectedGround, reflectedTrees]) { mat.transparent = true; mat.opacityNode = reflectOpacity; }
  const canopies = fieldSun
    ? [[0,12.6,0,5.0,4.4,5.0],[-2.7,9.2,1.5,5.0,3.8,4.8],[3.2,9.6,-1.2,4.8,3.8,4.9]]
    : [[0,11,0,7,5.6,6.6]];
  const canopyParts = canopies.map(([x,y,z,w,h,d])=>{
    const lobe = new THREE.IcosahedronGeometry(1,0);
    if (fieldSun) lobe.setAttribute('normal',lobe.getAttribute('position').clone());
    return lobe.scale(w,h,d).translate(x,y,z);
  });
  const stem = new THREE.CylinderGeometry(0.7,1.15,8,5,1,true).toNonIndexed().translate(0,4,0);
  for (const part of [...canopyParts,stem]) {
    const tint = part===stem ? '#77583d' : '#63865b';
    const colors = new Float32Array(part.attributes.position.count*3), color = new THREE.Color(tint);
    for (let i=0; i<colors.length; i+=3) color.toArray(colors,i);
    part.setAttribute('color',new THREE.BufferAttribute(colors,3));
  }
  const crown = mergeGeometries([...canopyParts,stem]);
  // The planar reflection only needs one crown mass per tree.
  const reflectionCrown = fieldSun ? mergeGeometries([canopyParts[0],stem]) : crown;
  canopyParts.forEach(part=>part.dispose()); stem.dispose();
  const group = new THREE.Group(), reflections = new THREE.Group();
  group.name = 'archipelago'; group.userData.separateLandReflection = true;
  scene.add(group);
  const fixture = [[0,0],[1,0],[-1,-1],[0,-2]].map(([i,j]) => islandAtCell(seed, i, j));
  const fixedIds = new Set(fixture.map(s => s.id));
  let cachedCol = Infinity, cachedRow = Infinity, cached: IslandSpec;
  function owner(x: number, z: number) {
    const col = gridCol(x), row = gridRow(z);
    if (col !== cachedCol || row !== cachedRow) {
      cachedCol = col; cachedRow = row; cached = islandAtCell(seed, col, row);
    }
    return !fixed || fixedIds.has(cached.id) ? cached : null;
  }
  const ocean = {height:-14, distance:-1000, normal:[0,1,0], wet:0, grass:0, woods:0, sand:0};
  function heightAt(x: number, z: number) {
    const s = owner(x, z);
    return s ? meshHeight(s, x, z) : -14;
  }
  const nearTrees: IslandTree[] = [];
  const flora = await plantIsland(group, {sample(x,z) {
    const s = owner(x, z);
    return s ? surface(s, x, z) : ocean;
  }}, nearTrees, seed, bark, leaves, ground, true, meadow, fieldSun ? {sun:fieldSun,horizon:haze.value} : undefined, distant);
  const treeCapacity = 96, detailed = flora.nearTreeBatch(treeCapacity);
  const atlasSide = MASK_SIDE * 3, pixels = new Uint8Array(atlasSide ** 2);
  const texture = new THREE.DataTexture(pixels, atlasSide, atlasSide, THREE.RedFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true;
  const coast = {texture, x:0, z:0, span:3 * PITCH, origin:new THREE.Vector2()};
  const land = new Map<string, Resident>(), tiles = new Map<string, () => void>();
  const stats = {worker:'active', resident:0, fieldTufts:0, tiles:0, pending:0, outstanding:0, loaded:0, evicted:0, stale:0,
    failures:0, lastError:'', exhausted:0, deferred:0, retries:0, peakTransfer:0, residentPacketBytes:0,
    maxResident:0, reflectionIslands:0, reflectionTriangles:0, missingNear:0, peakMissingNear:0};
  let atlasCol = Infinity, atlasRow = Infinity, dirty = true;
  function refreshAtlas(x: number, z: number) {
    const col = gridCol(x), row = gridRow(z);
    if (!dirty && col === atlasCol && row === atlasRow) return;
    atlasCol = col; atlasRow = row; dirty = false;
    pixels.fill(0);
    coast.origin.set((col - 1.5) * PITCH, (row - 1.5) * PITCH + ORIGIN_Z);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const cx = col + i - 1, cz = row + j - 1, spec = islandAtCell(seed, cx, cz), chunk = land.get(spec.id);
      if (!chunk) continue;
      const stride = spec.kind === 'large' ? MASK_SIDE * 2 : MASK_SIDE;
      for (let k = 0; k < MASK_SIDE; k++) {
        const start = ((cz - spec.row) * MASK_SIDE + k) * stride + (cx - spec.col) * MASK_SIDE;
        pixels.set(chunk.data.mask.subarray(start, start + MASK_SIDE), (j * MASK_SIDE + k) * atlasSide + i * MASK_SIDE);
      }
    }
    texture.needsUpdate = true;
  }
  function attach(job: Job, data: Packet) {
    const bytes = buffers(data).reduce((n,b) => n+b.byteLength, 0);
    stats.peakTransfer = Math.max(stats.peakTransfer, bytes);
    if (data.kind === 'grass') {
      const [i,j] = job.tile!;
      tiles.set(job.key, flora.addGrass((i+0.5)*GRASS_TILE, (j+0.5)*GRASS_TILE, data.matrices));
      return;
    }
    const root = new THREE.Group(), reflection = new THREE.Group();
    const farTrees = new THREE.InstancedMesh(crown, distant, 256);
    farTrees.count = data.trees.length;
    const pose = new THREE.Object3D();
    data.trees.forEach(({x,y,z,size}, i) => {
      pose.position.set(x,y,z); pose.scale.setScalar(size);
      pose.rotation.y = i*2.4; pose.updateMatrix(); farTrees.setMatrixAt(i,pose.matrix);
    });
    farTrees.computeBoundingSphere();
    const proxyTrees = new THREE.InstancedMesh(reflectionCrown, reflectedTrees, data.trees.length);
    proxyTrees.instanceMatrix.array.set(farTrees.instanceMatrix.array.subarray(0,data.trees.length*16)); proxyTrees.boundingSphere = farTrees.boundingSphere;
    reflection.add(new THREE.Mesh(geometry(data.proxy), reflectedGround), proxyTrees);
    root.add(new THREE.Mesh(geometry(data.full),ground), farTrees);
    if (data.cover && flora.strokes) root.add(new THREE.Mesh(fieldGeometry(data.cover),flora.strokes));
    group.add(root); reflections.add(reflection);
    land.set(job.key,{spec:job.spec,data,root,reflection,proxyTrees,farTrees,bytes});
    stats.fieldTufts += (data.cover?.anchors.length ?? 0)/3;
    stats.loaded++; stats.residentPacketBytes += bytes; dirty = true;
  }

  function evict(key: string, chunk: Resident) {
    for (const root of [chunk.root, chunk.reflection]) {
      root.removeFromParent();
      for (const child of root.children) if (child instanceof THREE.Mesh && !(child instanceof THREE.InstancedMesh)) child.geometry.dispose();
      root.traverse(child => { if (child instanceof THREE.InstancedMesh) child.dispose(); });
    }
    stats.fieldTufts -= (chunk.data.cover?.anchors.length ?? 0)/3;
    land.delete(key); stats.evicted++; stats.residentPacketBytes -= chunk.bytes; dirty = true;
  }
  let wanted = new Map<string, Job>(), queue: Job[] = [];
  const attempts = new Map<string, number>();
  let active: Job | undefined, reply: {packet?:Packet; error?:string} | undefined;
  let worker: Worker | undefined;
  function failedWorker(message: string) {
    worker?.terminate(); worker = undefined; stats.worker = 'fallback'; stats.lastError = message;
    if (active) reply = {error:message};
  }
  try {
    worker = new Worker(new URL('./archipelago.worker.ts', import.meta.url), {type:'module'});
    worker.onmessage = e => {reply = e.data;};
    worker.onerror = e => { e.preventDefault(); failedWorker(e.message); };
    worker.onmessageerror = () => failedWorker('Invalid worker response');
  } catch(e) { failedWorker(String(e)); }
  function pump() {
    if (reply && active) {
      const {packet,error} = reply, job = active;
      active = reply = undefined;
      if (!wanted.has(job.key)) stats.stale++;
      else if (packet) attach(job, packet);
      else {
        stats.failures++; stats.lastError = error ?? 'Empty response';
        const n = (attempts.get(job.key) ?? 0) + 1; attempts.set(job.key,n);
        if (n < 2) { queue.push(job); stats.retries++; } else stats.exhausted++;
      }
    }
    if (!active && queue.length) {
      const job = active = queue.shift()!;
      if (worker) {
        try { worker.postMessage(job); } catch(e) { failedWorker(String(e)); }
      } else setTimeout(() => {
        try { reply = {packet:generate(job)}; }
        catch(e) { reply = {error:String(e)}; }
      }, 0);
    }
    stats.outstanding = active ? 1 : 0; stats.pending = queue.length + stats.outstanding;
    stats.resident = land.size; stats.tiles = tiles.size; stats.maxResident = Math.max(stats.maxResident, land.size);
  }
  const gap = (s: IslandSpec, x: number, z: number) => Math.hypot(x-s.x,z-s.z)-s.radius;
  let lastX = Infinity, lastZ = Infinity;
  function plan(x: number, z: number) {
    lastX = x; lastZ = z;
    const specs = new Map<string,IslandSpec>(), col = gridCol(x), row = gridRow(z);
    if (fixed) fixture.forEach(s => specs.set(s.id,s));
    else for (let j = row-4; j <= row+4; j++) for (let i = col-4; i <= col+4; i++) {
      const s = islandAtCell(seed,i,j);
      if (gap(s,x,z) <= PRELOAD) specs.set(s.id,s);
    }
    const ranked = [...specs.values()].sort((a,b) => gap(a,x,z)-gap(b,x,z));
    const jobs = ranked.slice(0, LAND_LIMIT).map(spec => ({key:spec.id,spec,painted:!!fieldSun,priority:gap(spec,x,z)-400} as Job & {priority:number}));
    const grassJobs: typeof jobs = [];
    const tx = Math.floor(x/GRASS_TILE), tz = Math.floor(z/GRASS_TILE);
    for (let j = tz-6; j <= tz+6; j++) for (let i = tx-6; i <= tx+6; i++) {
      const px = (i+0.5)*GRASS_TILE, pz = (j+0.5)*GRASS_TILE, dist = Math.hypot(px-x,pz-z);
      if (dist > 190) continue;
      const spec = owner(px,pz);
      if (spec && shore(spec,px,pz) > -8) grassJobs.push({key:'g'+i+','+j,spec,tile:[i,j],priority:dist});
    }
    grassJobs.sort((a,b)=>a.priority-b.priority);
    stats.deferred += Math.max(0, ranked.length-LAND_LIMIT) + Math.max(0, grassJobs.length-TILE_LIMIT);
    jobs.push(...grassJobs.slice(0,TILE_LIMIT)); jobs.sort((a,b)=>a.priority-b.priority);
    wanted = new Map(jobs.map(j=>[j.key,j]));
    for (const [key,chunk] of land) if (!wanted.has(key)) evict(key,chunk);
    for (const [key,release] of tiles) if (!wanted.has(key)) {release(); tiles.delete(key);}
    for (const key of attempts.keys()) if (!wanted.has(key)) attempts.delete(key);
    queue = jobs.filter(j=>!land.has(j.key) && !tiles.has(j.key) && active?.key !== j.key && (attempts.get(j.key) ?? 0)<2);
  }
  type Entry = {tree: IslandTree; chunk: Resident; index: number; distance: number};
  let selected = new Map<IslandTree,Entry>(), desired: Entry[] = [];
  let treeX = Infinity, treeZ = Infinity, landVersion = -1;
  const hidden = new THREE.Matrix4().makeScale(0,0,0), original = new THREE.Matrix4();
  function showProxy(entry: Entry, visible: boolean) {
    const {chunk,index} = entry;
    if (visible) chunk.proxyTrees.getMatrixAt(index,original);
    chunk.farTrees.setMatrixAt(index,visible ? original : hidden);
    chunk.farTrees.instanceMatrix.addUpdateRange(index*16,16);
    chunk.farTrees.instanceMatrix.needsUpdate = true;
  }
  function updateTrees(eye: Point) {
    const version = stats.loaded + stats.evicted;
    if (version !== landVersion || Math.hypot(eye.x-treeX,eye.z-treeZ)>12) {
      treeX = eye.x; treeZ = eye.z; landVersion = version;
      const candidates: Entry[] = [];
      for (const chunk of land.values()) {
        if (gap(chunk.spec,eye.x,eye.z)>240) continue;
        chunk.data.trees.forEach((tree,index)=>{
          const distance = Math.hypot(tree.x-eye.x,tree.z-eye.z);
          if (distance < (selected.has(tree)?240:215)) candidates.push({tree,chunk,index,distance});
        });
      }
      desired = candidates.sort((a,b)=>a.distance-b.distance).slice(0,treeCapacity);
      const wanted = new Set(desired.map(e=>e.tree));
      for (const [tree,e] of selected) if (!wanted.has(tree)) {
        if (land.has(e.chunk.spec.id)) showProxy(e,true);
        selected.delete(tree);
      }
    }
    let added = 0;
    for (const e of desired) if (!selected.has(e.tree)) {
      selected.set(e.tree,e); showProxy(e,false);
      if (++added === 8) break;
    }
    nearTrees.length = 0;
    nearTrees.push(...selected.keys());
    detailed.replace(nearTrees);
  }
  function update(time: number, p: Point, eye: Point, high: boolean) {
    if (Math.hypot(eye.x-lastX,eye.z-lastZ)>24) plan(eye.x,eye.z);
    pump(); refreshAtlas(eye.x,eye.z);
    updateTrees(eye);
    stats.reflectionIslands = stats.reflectionTriangles = 0;
    for (const chunk of land.values()) {
      const d = gap(chunk.spec,eye.x,eye.z);
      chunk.reflection.visible = d < 650;
      if (reflections.visible && chunk.reflection.visible) {
        stats.reflectionIslands++;
        stats.reflectionTriangles += chunk.data.proxy.index.length/3 + reflectionCrown.attributes.position.count/3*chunk.data.trees.length;
      }
    }
    stats.missingNear = 0;
    for (const j of wanted.values()) if (!j.tile && gap(j.spec,eye.x,eye.z)<700 && !land.has(j.key)) stats.missingNear++;
    stats.peakMissingNear = Math.max(stats.peakMissingNear,stats.missingNear);
    flora.update(time,p,eye,high);
  }
  plan(start.x,start.z);
  do {
    pump();
    if (stats.pending) await new Promise(resolve=>setTimeout(resolve,1));
  } while (stats.pending);
  refreshAtlas(start.x,start.z);
  function setLight(el:number, horizon:readonly number[]) {
    const day = smooth(-8,4,el), dusk = day*(1-smooth(10,48,el));
    fill.value.setRGB(.035+day*.19+dusk*.24,.065+day*.18+dusk*.12,.14+day*.15);
    haze.value.setRGB(horizon[0],horizon[1],horizon[2]);
    ground.color.setRGB(.54+.46*day,.70+.30*day,1);
    leaves.color.copy(ground.color); reflectedGround.color.copy(ground.color);
  }
  return {treePreview:detailed.root, heightAt, coast, reflections, stats, flora:flora.stats, update, setLight,
    setReflection(on:boolean){reflections.visible = on;},
    inventory:()=>[...land.values()].map(({spec,data})=>({id:spec.id,kind:spec.kind,x:spec.x,z:spec.z,
      waterways:data.waterways, trees:data.trees.length, triangles:data.full.index.length/3, peak:data.full.position[3*((32*65)+32)+1]}))};
}
