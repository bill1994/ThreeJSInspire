import * as THREE from 'three';
import * as T from 'three/tsl';
import type { MeshLambertNodeMaterial } from 'three/webgpu';
import { seededRandom } from './terrain';

type Lambert = MeshLambertNodeMaterial;
export interface FieldLight { sun: THREE.Vector3; horizon: THREE.Color }

// Two repeatable fields in one mipmapped texture. Red is the shape of a
// clearing, green is a signed brush mark. Both are sampled in world metres.
function meadowAtlas() {
  const size = 256, random = seededRandom(78093);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0,0,size,size);
  for (let i=0; i<245; i++) {
    const x=random()*size, y=random()*size, angle=-0.38+0.5*Math.sin(y*Math.PI*2/size);
    const length=2+random()*9, light=random()>0.48;
    ctx.fillStyle=light?'#ebebeb':'#303030';
    for (const dx of [-size,0,size]) for (const dy of [-size,0,size]) {
      for (let blade=0;blade<3;blade++) {
        const px=x+dx+blade*1.6, py=y+dy, reach=length*(1-blade*.19);
        ctx.beginPath();ctx.moveTo(px,py);
        ctx.quadraticCurveTo(px+reach*.5,py-.8,px+reach,py+reach*(angle-.17*blade));
        ctx.quadraticCurveTo(px+reach*.33,py+1.3,px,py);ctx.fill();
      }
    }
  }
  const pixels=ctx.getImageData(0,0,size,size).data;
  function periodicNoise(cells:number) {
    const samples=Float32Array.from({length:cells*cells},()=>random());
    const at=(x:number,y:number)=>samples[(x%cells)+cells*(y%cells)];
    return (x:number,y:number)=>{
      const u=x*cells/size,v=y*cells/size,i=Math.floor(u),j=Math.floor(v);
      const a=u-i,b=v-j,tx=a*a*(3-2*a),ty=b*b*(3-2*b);
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(i,j),at(i+1,j),tx),
        THREE.MathUtils.lerp(at(i,j+1),at(i+1,j+1),tx),ty);
    };
  }
  const wide=periodicNoise(4), narrow=periodicNoise(11);
  const data=new Uint8Array(size*size*4);
  for(let z=0;z<size;z++) for(let x=0;x<size;x++){
    const k=4*(z*size+x);
    data[k]=255*(.74*wide(x,z)+.26*narrow(x,z));
    data[k+1]=pixels[k]; data[k+3]=255;
  }
  const tex=new THREE.DataTexture(data,size,size);
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  tex.generateMipmaps=true;tex.minFilter=THREE.LinearMipmapLinearFilter;tex.magFilter=THREE.LinearFilter;
  tex.anisotropy=4;tex.needsUpdate=true;
  return tex;
}

export function shadeField(ground:Lambert, blades:Lambert, leaves:Lambert, farTrees:Lambert|undefined,
  light:FieldLight, clock:ReturnType<typeof T.uniform<'float',number>>) {
  const atlas=meadowAtlas(), p=T.positionWorld.xz, sun=T.uniform(light.sun), horizon=T.uniform(light.horizon);
  const warp=T.vec2(p.y.div(77).sin(),p.x.div(87).cos()).mul(13);
  const uv=p.add(warp);
  const large=T.texture(atlas,uv.mul(T.vec2(1/274,1/202)));
  const middle=T.texture(atlas,T.vec2(uv.y,uv.x.negate()).mul(T.vec2(1/61,1/43)));
  const brush=T.texture(atlas,uv.div(24)).g.sub(.5);
  const range=T.positionWorld.distance(T.cameraPosition);
  const day=T.smoothstep(-.13,.22,sun.y);
  const dusk=T.smoothstep(.02,.6,sun.y).oneMinus();
  const tint=T.mix(T.vec3(.09,.16,.31),T.vec3(1.0,dusk.mul(-.22).add(1),dusk.mul(-.32).add(1)),day);
  const air=T.smoothstep(280,1750,range).mul(.44);
  const normal=T.normalWorldGeometry;
  // Ground and blades use the same height-independent pigment. The signed
  // wind stroke travels through the field even outside the grass mesh radius.
  const field=large.r.mul(.77).add(middle.r.mul(.23));
  const wind=p.x.mul(.063).add(p.y.mul(.029)).add(large.r.mul(6)).sub(clock.mul(.87)).sin();
  const windLight=T.smoothstep(.66,.95,wind).mul(T.smoothstep(.32,.65,middle.r)).mul(.06);
  // The main division follows the hill facing the sun. Pigment breaks up
  // its edges, while the lee slope keeps one connected, cooler shadow mass.
  const sunwardSlope=normal.xz.dot(sun.xz.div(sun.xz.length().max(.2)));
  const lightness=field.sub(.5).mul(.48).add(sunwardSlope.mul(.52))
    .add(normal.dot(sun).mul(.13)).add(.42).add(windLight);
  const cool=T.color('#528d77'), green=T.color('#7aaf69'), sunward=T.color('#abc47b');
  const base=T.mix(T.mix(cool,green,T.smoothstep(.33,.47,lightness)),sunward,T.smoothstep(.55,.67,lightness));
  const marks=middle.g.sub(.5).mul(.24).add(brush.mul(.22));
  const pigment=base.mul(marks.add(1));
  const finish=(color:typeof pigment)=>T.mix(color.mul(tint),horizon,air);
  const color=T.vertexColor();
  const cover=T.smoothstep(-.025,.075,color.g.sub(color.r));
  const grove=T.smoothstep(.27,.43,color.g).oneMinus();
  const understory=T.mix(pigment,pigment.mul(T.vec3(.70,.82,.85)),grove.mul(.75));
  ground.outputNode=T.vec4(T.mix(T.output.rgb,finish(understory),cover),T.output.a);

  const detail=T.smoothstep(22,122,range).oneMinus();
  const tip=T.attribute('bend','float');
  const fold=T.attribute('fold','float');
  const leafTone=tip.mul(.47).add(fold.mul(.15)).sub(.21).mul(detail);
  blades.fragmentNode=T.vec4(finish(pigment.mul(leafTone.add(1)).add(T.vec3(.065,.055,.009).mul(tip).mul(detail))),1);

  // Round crowns retain two broad light masses at either mesh resolution.
  const facing=normal.dot(sun).add(large.r.sub(.5).mul(.23));
  const crown=T.mix(T.color('#3d7363'),T.color('#68975d'),T.smoothstep(.08,.29,facing));
  const lit=T.mix(crown,T.color('#91b174'),T.smoothstep(.65,.84,facing));
  leaves.outputNode=T.vec4(T.mix(finish(lit),T.output.rgb,.15),1);
  const strokes=blades.clone();
  strokes.vertexColors=false;
  const a=T.attribute('anchor','vec3'), n=T.attribute('normal','vec3');
  const shape=T.positionGeometry, phase=a.x.mul(.731).add(a.z.mul(.347)).sin();
  const angle=phase.mul(1.23), c=angle.cos(), s=angle.sin();
  const dx=shape.x.mul(c).sub(shape.z.mul(s)), dz=shape.x.mul(s).add(shape.z.mul(c));
  const groundY=dx.mul(n.x).add(dz.mul(n.z)).div(n.y.max(.25)).negate();
  const h=shape.y.mul(phase.mul(.22).add(1));
  const breeze=a.x.mul(.08).add(a.z.mul(.06)).sub(clock.mul(1.5)).sin().mul(h).mul(.12);
  strokes.positionNode=a.add(T.vec3(dx.add(breeze),groundY.add(h),dz));
  const accent=T.smoothstep(0,1.6,shape.y).mul(.36).sub(.09);
  strokes.fragmentNode=T.vec4(finish(pigment.mul(accent.add(1))),1);
  if(farTrees) farTrees.outputNode=T.vec4(T.mix(T.output.rgb,finish(lit),cover),1);
  return strokes;
}
