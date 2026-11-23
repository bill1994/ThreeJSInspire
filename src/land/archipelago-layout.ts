import { seededRandom, smooth, gridPeak } from './terrain';

export const PITCH = 1000, ORIGIN_Z = -360;
export interface IslandSpec {
  id: string; worldSeed: number; col: number; row: number; x: number; z: number;
  radius: number; relief: number; seed: number; phase: number; kind: 'small' | 'medium' | 'large';
}
export function cellSeed(seed: number, x: number, z: number) {
  let h = seed ^ Math.imul(x, 0x45d9f3b) ^ Math.imul(z, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}
export const gridCol = (x: number) => Math.floor(x / PITCH + 0.5);
export const gridRow = (z: number) => gridCol(z - ORIGIN_Z);

// A large island owns a 2x2 footprint wholly inside its 6x6 district.
// Cardinal edges of the original lattice become the island connection graph.
export function islandAtCell(seed: number, col: number, row: number): IslandSpec {
  const mx = Math.floor((col + 2) / 6), mz = Math.floor((row + 4) / 6);
  const district = cellSeed(seed, mx, mz);
  const ax = 6 * mx - 2 + (mx === 0 && mz === 0 ? 2 : 1 + district % 3);
  const az = 6 * mz - 4 + (mx === 0 && mz === 0 ? 2 : 1 + (district >>> 8) % 3);
  const large = col >= ax && col <= ax+1 && row >= az && row <= az+1;
  if (large) { col = ax; row = az; }
  const hash = cellSeed(seed, col, row), random = seededRandom(hash);
  const medium = !large && col % 2 === 0 && row % 2 === 0 && (col !== 0 || row !== 0) && random() < 0.66;
  const radius = large ? 823 + random()*22 : medium ? 408 + random()*12 : 201 + random()*60;
  return {id: col+','+row, worldSeed:seed, col,row, seed:hash, kind:large?'large':medium?'medium':'small',
    x:(col+(large?0.5:0))*PITCH+(random()-0.5)*26,
    z:(row+(large?0.5:0))*PITCH+ORIGIN_Z+(random()-0.5)*26,
    phase:random()*Math.PI*2, radius, relief:large?103+random()*23:medium?59+random()*17:30+random()*22};
}

// Positive inside. The radial envelope is also a constructive spacing proof:
// every footprint contains a disk of radius .80R and lies inside radius R.
export function shoreRadius(s: IslandSpec, angle: number) {
  const t = angle+s.phase;
  const bay = Math.max(0,Math.cos(t*2-0.6))**4;
  return s.radius*Math.max(0.80,Math.min(1,0.93+0.052*Math.cos(t*2)+0.047*Math.sin(3*t+s.phase)
    +0.020*Math.cos(5*t)-0.105*bay*Math.max(0,Math.sin(t))));
}
// A bounding disk supplies the lower clearance bound. The two coastline
// points on the line of centres supply an upper bound on the shortest crossing.
export function waterwayBounds(s: IslandSpec) {
  const size = s.kind === 'large' ? 2 : 1;
  let lower = Infinity, upper = 0;
  function check(col: number, row: number) {
    const next = islandAtCell(s.worldSeed, col, row);
    const dx = next.x - s.x, dz = next.z - s.z, distance = Math.hypot(dx, dz);
    lower = Math.min(lower, distance - s.radius - next.radius);
    const angle = Math.atan2(dz, dx);
    upper = Math.max(upper, distance - shoreRadius(s, angle) - shoreRadius(next, angle + Math.PI));
  }
  for (let n = 0; n < size; n++) {
    check(s.col - 1, s.row + n); check(s.col + size, s.row + n);
    check(s.col + n, s.row - 1); check(s.col + n, s.row + size);
  }
  return {lower, upper};
}
export function shore(s: IslandSpec,x:number,z:number) {
  const dx=x-s.x,dz=z-s.z;
  return shoreRadius(s,Math.atan2(dz,dx))-Math.hypot(dx,dz);
}
export function elevation(s:IslandSpec,x:number,z:number,d=shore(s,x,z)){
  if(d<0) return Math.max(-14,d*0.23);
  const dx=(x-s.x)/s.radius,dz=(z-s.z)/s.radius,c=Math.cos(s.phase),t=Math.sin(s.phase);
  const u=dx*c-dz*t,v=dx*t+dz*c;
  const ridge=Math.exp(-((u+0.31)**2/0.15+(v+0.10)**2/0.24));
  const second=Math.exp(-((u-0.34)**2/0.12+(v-0.18)**2/0.15));
  return Math.min(32,d)*0.20 + smooth(12,Math.min(90,s.radius*0.29),d)*s.relief*(ridge+0.63*second);
}
export function biome(s:IslandSpec,x:number,z:number,d:number) {
  const green=smooth(16+5*Math.cos(x/45),35+6*Math.sin(z/51),d);
  const woods=green*smooth(-0.22,0.72,Math.sin(x/51+s.phase)*0.73+Math.cos(z/63+x/107)*0.64);
  const wet=(1-smooth(1,15,d))*(1-green);
  return {grass:green-woods,woods,wet,sand:1-green-wet};
}
export const SIDE=64;
export const extent=(s:IslandSpec)=>s.radius+32;
export function footprintPeak(seed:number,x:number,z:number,w:number,d:number,allowed?:ReadonlySet<string>) {
  const seen=new Set<string>();
  let peak=-14;
  for(let row=gridRow(z-d);row<=gridRow(z+d);row++) for(let col=gridCol(x-w);col<=gridCol(x+w);col++){
    const s=islandAtCell(seed,col,row);
    if(seen.has(s.id) || (allowed && !allowed.has(s.id))) continue;
    seen.add(s.id);
    const half=extent(s), step=2*half/SIDE, ox=s.x-half, oz=s.z-half;
    peak=Math.max(peak,gridPeak(x,z,w,d,ox,oz,step,SIDE,(i,j)=>elevation(s,ox+i*step,oz+j*step)));
  }
  return peak;
}
export function meshHeight(s:IslandSpec,x:number,z:number){
  const half=extent(s), step=2*half/SIDE, u=(x-s.x+half)/step,v=(z-s.z+half)/step;
  if(u<0||v<0||u>=SIDE||v>=SIDE)return -14;
  const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j;
  const px=s.x-half+i*step,pz=s.z-half+j*step;
  const right=elevation(s,px+step,pz),bottom=elevation(s,px,pz+step);
  return a+b<=1 ? elevation(s,px,pz)*(1-a-b)+right*a+bottom*b :
    elevation(s,px+step,pz+step)*(a+b-1)+right*(1-b)+bottom*(1-a);
}
export function surface(s:IslandSpec,x:number,z:number) {
  const d=shore(s,x,z), height=meshHeight(s,x,z);
  const nx=(elevation(s,x-2,z)-elevation(s,x+2,z))/4,nz=(elevation(s,x,z-2)-elevation(s,x,z+2))/4;
  const len=Math.hypot(nx,1,nz);
  return {height,distance:d,normal:[nx/len,1/len,nz/len],...biome(s,x,z,d)};
}
