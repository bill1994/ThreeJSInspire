import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { meshHeight, shoreRadius, type IslandSpec } from './archipelago-layout';

const TOWER_BASE_RADIUS = 4.2;
export const PLATFORM_RADIUS = 10;
export const PLATFORM_BOTTOM = -14;
const DECK = 3.2;
const LANTERN_HEIGHT = 25;
type PointXZ = {x:number; z:number};

/** One freestanding caisson just offshore of a large island. Sea level is world y=0. */
export function lighthouseSite(s:IslandSpec, harbour:PointXZ|null) {
  if(s.kind!=='large') return null;
  let best:{x:number;y:number;z:number;yaw:number;score:number}|null=null;
  for(let i=0;i<96;i++) {
    const a=s.phase+i*Math.PI/48, dx=Math.cos(a), dz=Math.sin(a);
    const coast=shoreRadius(s,a), r=coast+36, x=s.x+r*dx, z=s.z+r*dz;
    const separation=harbour?Math.hypot(x-harbour.x,z-harbour.z):220;
    if(separation<95 || meshHeight(s,x-65*dx,z-65*dz)<1) continue;
    let low=meshHeight(s,x,z),high=low;
    for(let j=0;j<16;j++) {
      const b=j*Math.PI/8;
      const h=meshHeight(s,x+PLATFORM_RADIUS*Math.cos(b),z+PLATFORM_RADIUS*Math.sin(b));
      low=Math.min(low,h); high=Math.max(high,h);
    }
    if(high>-2 || low<PLATFORM_BOTTOM+1) continue;
    const score=coast/s.radius*8-Math.abs(separation-220)*.02-Math.abs((low+high)/2+8)*.1;
    if(!best || score>best.score) best={x,y:0,z,yaw:Math.atan2(dx,dz),score};
  }
  return best;
}

export function lighthouseGeometry() {
  const parts:THREE.BufferGeometry[]=[];
  function paint(g:THREE.BufferGeometry, tint:string) {
    const color=new THREE.Color(tint), data=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<data.length;i+=3) color.toArray(data,i);
    g.setAttribute('color',new THREE.BufferAttribute(data,3));
    parts.push(g);
  }
  function drum(bottom:number,top:number,y0:number,y1:number,color:string) {
    paint(new THREE.CylinderGeometry(top,bottom,y1-y0,16).translate(0,(y0+y1)/2,0),color);
  }
  // The submerged toe, tide-stained wall and overhanging cap read as one sea foundation.
  drum(PLATFORM_RADIUS,8.4,PLATFORM_BOTTOM,.75,'#64665f');
  drum(8.4,8.05,.75,DECK-.45,'#a19a85');
  drum(8.35,8.35,DECK-.45,DECK,'#c5ba9e');
  drum(TOWER_BASE_RADIUS+.45,TOWER_BASE_RADIUS,DECK,DECK+.35,'#746e60');
  drum(3.55,2.99,DECK+.35,10.5,'#f4e8c8');
  drum(2.99,2.52,10.5,16.6,'#bb5341');
  drum(2.52,2.08,16.6,22.3,'#f4e8c8');
  drum(2.1,3.05,22.3,23.1,'#555451');
  drum(3.05,3.05,23.1,23.45,'#414949');
  drum(1.8,1.8,23.45,26.6,'#697c78');
  for(let i=0;i<8;i++) {
    const a=i*Math.PI/4;
    paint(new THREE.BoxGeometry(.15,3.2,.15).translate(1.86*Math.cos(a),25,1.86*Math.sin(a)),'#363f40');
    paint(new THREE.BoxGeometry(.13,.96,.13).translate(2.83*Math.cos(a),23.9,2.83*Math.sin(a)),'#464746');
  }
  paint(new THREE.TorusGeometry(2.82,.09,5,16).rotateX(Math.PI/2).translate(0,24.37,0),'#464746');
  drum(2.55,.17,26.6,28.4,'#9a493b');
  paint(new THREE.BoxGeometry(1.22,2.5,.52).translate(0,4.45,3.27),'#52534b');
  const geometry=mergeGeometries(parts)!;
  parts.forEach(p=>p.dispose());
  return geometry;
}

export async function lighthouseKit() {
  const T=await import('three/tsl');
  const {MeshBasicNodeMaterial,MeshLambertNodeMaterial}=await import('three/webgpu');
  const geometry=lighthouseGeometry(), masonry=new MeshLambertNodeMaterial({vertexColors:true});
  const night=T.uniform(0);
  Object.assign(masonry,{emissiveNode:T.vertexColor().rgb.mul(T.mix(.32,.045,night))});
  const glass=new MeshBasicNodeMaterial();
  glass.colorNode=T.mix(T.color('#76837e'),T.vec3(2.5,1.65,.67),night);
  const lens=new THREE.CylinderGeometry(1.84,1.84,1.75,16);
  const fog=new MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
  const axial=T.uv().y;
  const feather=T.normalWorld.dot(T.positionViewDirection.transformDirection(T.cameraWorldMatrix)).abs();
  fog.colorNode=T.vec4(T.vec3(1,.78,.43),T.smoothstep(0,.46,feather)
    .mul(T.smoothstep(0,1,axial).oneMinus()).mul(night).mul(.24));
  const length=175;
  const cone=new THREE.CylinderGeometry(10,.75,length,24,1,true)
    .translate(0,length/2,0).rotateX(Math.PI/2);
  return {geometry,night,masonry,glass,create(site:{x:number;y:number;z:number;yaw:number}) {
    const root=new THREE.Group();
    root.name='coastal-lighthouse';
    root.position.set(site.x,site.y,site.z);
    root.rotation.y=site.yaw;
    root.add(new THREE.Mesh(geometry,masonry));
    const lamp=new THREE.Mesh(lens,glass);
    lamp.position.y=LANTERN_HEIGHT;
    root.add(lamp);
    const beam=new THREE.Mesh(cone,fog);
    beam.position.y=LANTERN_HEIGHT;
    beam.name='lighthouse-beam';
    root.add(beam);
    return {root,beam};
  }};
}
