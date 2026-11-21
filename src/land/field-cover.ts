import * as THREE from 'three';
import { seededRandom } from './terrain';

interface Ground { height:number; normal:number[]; grass:number; woods:number }
export function fieldRoots(seed:number, left:number, back:number, span:number, sample:(x:number,z:number)=>Ground) {
  const random=seededRandom(seed+987), anchors:number[]=[], normals:number[]=[];
  const cells=Math.min(48,Math.ceil(span/8));
  for(let j=0;j<cells;j++) for(let i=0;i<cells;i++){
    const x=left+(i+random())*span/cells, z=back+(j+random())*span/cells;
    const g=sample(x,z);
    if(random() >= (g.grass+.35*g.woods)*.9) continue;
    anchors.push(x,g.height,z); normals.push(...g.normal);
  }
  return {anchors:Float32Array.from(anchors),normals:Float32Array.from(normals)};
}

// A few upright strokes give the skyline and the hill face a grassy silhouette
// even while the nearby interactive tiles are still in the worker queue.
export function fieldGeometry(roots:ReturnType<typeof fieldRoots>) {
  const g=new THREE.InstancedBufferGeometry(), points:number[]=[];
  for(const [x,z,width,height,lean] of [[-1.5,.1,.65,1.15,1.3],[-.6,-.3,.85,1.85,1.2],[.65,.45,.75,1.42,1.7],[1.6,0,.44,.85,1.1]]){
    points.push(x-width,-.14,z,x+width,-.14,z+.22,x+lean,height,z+.37);
  }
  g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
  g.setAttribute('anchor',new THREE.InstancedBufferAttribute(roots.anchors,3));
  g.setAttribute('normal',new THREE.InstancedBufferAttribute(roots.normals,3));
  g.instanceCount=roots.anchors.length/3;
  const box=new THREE.Box3().setFromBufferAttribute(g.getAttribute('anchor') as THREE.BufferAttribute);
  g.boundingSphere=box.expandByScalar(8).getBoundingSphere(new THREE.Sphere());
  return g;
}
