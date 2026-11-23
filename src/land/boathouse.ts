import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { meshHeight, shoreRadius, type IslandSpec } from './archipelago-layout';

/** One owner per island. Re-evaluate from the island record on return flights. */
export function harbourSite(s:IslandSpec,trees:readonly {x:number;z:number}[]) {
  if(s.kind!=='large' && (s.kind==='small' || s.seed%4!==0))return null;
  let best:{x:number;y:number;z:number;yaw:number;score:number}|null=null;
  for(let i=0;i<32;i++){
    const a=s.phase+2*Math.PI*i/32,dx=Math.cos(a),dz=Math.sin(a);
    const r=shoreRadius(s,a),x=s.x+(r-13)*dx,z=s.z+(r-13)*dz;
    const heights=[];
    for(const side of [-6,6])for(const end of [-5,5]){
      heights.push(meshHeight(s,x+dx*end-dz*side,z+dz*end+dx*side));
    }
    const low=Math.min(...heights),high=Math.max(...heights);
    if(low<.15 || high-low>3.5 || meshHeight(s,x+26*dx,z+26*dz)>-.5 ||
      trees.some(t=>Math.hypot(t.x-x,t.z-z)<13)) continue;
    const score=(s.radius-r)/s.radius + dz*.07-(high-low)*.03;
    if(!best || score>best.score)best={x,y:low,z,yaw:Math.atan2(dx,dz),score};
  }
  return best;
}

export function boathouseGeometry(detail:boolean) {
  const pieces:THREE.BufferGeometry[]=[];
  function box(x:number,y:number,z:number,w:number,h:number,d:number,paint:string,tilt=0){
    const g=new THREE.BoxGeometry(w,h,d).toNonIndexed().rotateZ(tilt).translate(x,y,z);
    const tint=new THREE.Color(paint), count=g.attributes.position.count;
    const colors=new Float32Array(count*3);
    for(let i=0;i<count;i++)tint.toArray(colors,i*3);
    g.setAttribute('color',new THREE.BufferAttribute(colors,3));pieces.push(g);
  }
  box(0,1.5,0,11,6,9,'#baa989');
  box(-2.9,5.4,0,6.7,.55,10.5,'#b36b52',.28);
  box(2.9,5.4,0,6.7,.55,10.5,'#a25b48',-.28);
  box(0,1.3,4.53,6.8,3.8,.18,'#505c55');
  box(0,.2,16,2.7,.55,24,'#87735a');
  if(detail)for(let z=7;z<=28;z+=5)for(const x of [-1.2,1.2])
    box(x,-2,z,.38,5.5,.38,'#645948');
  const merged=mergeGeometries(pieces)!;
  for(const p of pieces)p.dispose();
  return merged;
}
