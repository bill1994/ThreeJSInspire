import * as THREE from 'three';
import * as T from 'three/tsl';
import type { MeshLambertNodeMaterial } from 'three/webgpu';
import { seededRandom } from './terrain';

// A periodic paint tile, filtered by footprint at grazing angles. The two
// world-space scales break up repeats and survive the transition to geometry.
export function paintMeadow(material: MeshLambertNodeMaterial) {
  const canvas = document.createElement('canvas');
  const size = canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const random = seededRandom(294751);
  ctx.fillStyle = '#808080'; ctx.fillRect(0,0,size,size);
  for (let i=0; i<510; i++) {
    const x=random()*size, y=random()*size, length=3+random()*12;
    const tilt=0.3+0.55*Math.sin(y*2*Math.PI/size)+0.45*random();
    const ink=random()<0.47?'#b3b3b3':'#525252';
    ctx.fillStyle=ink;
    for(const dx of [-size,0,size]) for(const dy of [-size,0,size]) {
      const px=x+dx, py=y+dy;
      ctx.beginPath(); ctx.moveTo(px,py);
      ctx.quadraticCurveTo(px+length*0.35,py-2.5,px+length,py-length*tilt);
      ctx.quadraticCurveTo(px+length*0.55,py+1.5,px,py); ctx.fill();
    }
  }
  const stamp=new THREE.CanvasTexture(canvas);
  stamp.wrapS=stamp.wrapT=THREE.RepeatWrapping;
  stamp.anisotropy=4;
  const p=T.positionWorld.xz;
  const uv=p.add(T.vec2(p.y.div(24).sin(),p.x.div(33).sin()).mul(3));
  const fine=T.texture(stamp,uv.div(24)).r.sub(0.5);
  const broad=T.texture(stamp,T.vec2(uv.y.negate(),uv.x).div(73)).r.sub(0.5);
  const swath=p.x.div(17).add(p.y.div(29).sin().mul(2)).sin()
    .mul(p.y.div(38).sub(p.x.div(51)).cos());
  const cover=T.smoothstep(-0.01,0.11,T.vertexColor().g.sub(T.vertexColor().r));
  const value=fine.mul(0.55).add(broad.mul(0.34)).add(swath.mul(0.12));
  material.colorNode=T.materialColor.rgb.mul(T.vec3(1).add(
    T.vec3(value.add(swath.mul(0.08)),value,value.sub(swath.mul(0.09))).mul(cover)));
}
