import * as THREE from 'three';

export const OBJECT_REFLECTION = { highSize: 512, lowSize: 256, highHz: 30, lowHz: 15 } as const;

/** Future terrain opts in with root.userData.waterReflect = true. Never include
 * the water, background shell, post effects or the reflection itself. */
export function waterReflectables(scene: THREE.Scene): THREE.Object3D[] {
  const result: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D, selected: boolean) => {
    if (!o.visible || o.userData.separateLandReflection) return;
    const include = selected || o.name === 'porco_root' || o.name === 'puff-field' || o.userData.waterReflect === true;
    if ((o as THREE.Light).isLight || (include && (o as THREE.Mesh).isMesh && !o.name.startsWith('sea-r'))) result.push(o);
    for (const child of o.children) visit(child, include);
  };
  visit(scene,false);
  return result;
}

/** Reflection across y=0, with a standard projection so volume depth decoding
 * stays valid. Clipping belongs to the private capture scene instead. */
export function mirrorWaterCamera(source: THREE.PerspectiveCamera, target: THREE.PerspectiveCamera) {
  source.updateMatrixWorld();
  const position=source.getWorldPosition(new THREE.Vector3());
  const direction=source.getWorldDirection(new THREE.Vector3());
  const up=new THREE.Vector3(0,1,0).transformDirection(source.matrixWorld);
  position.y=-position.y; direction.y=-direction.y; up.y=-up.y;
  target.position.copy(position); target.up.copy(up); target.lookAt(position.clone().add(direction));
  target.near=source.near; target.far=source.far; target.coordinateSystem=source.coordinateSystem;
  target.projectionMatrix.copy(source.projectionMatrix);
  target.projectionMatrixInverse.copy(source.projectionMatrixInverse);
  target.updateMatrixWorld();
}

export async function initObjectReflection(renderer: any) {
  const { ClippingGroup }=await import('three/webgpu');
  const T=await import('three/tsl');
  const { uniform }=T;
  const target=new THREE.RenderTarget(1,1,{type:THREE.HalfFloatType,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter});
  target.texture.name='sea_object_reflection';
  const capture=new THREE.Scene(), group=new ClippingGroup();
  group.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,1,0),0)];
  capture.add(group);
  const camera=new THREE.PerspectiveCamera(), matrix=uniform(new THREE.Matrix4()), enabled=uniform(0), strength=uniform(1), puffSoftness=uniform(1);
  const pairs=new Map<THREE.Object3D,THREE.Object3D>(), size=new THREE.Vector2(), clear=new THREE.Color();
  const puffMaterials=new Map<THREE.Object3D,THREE.Material>();
  let high=true, previous=-Infinity, captures=0;
  const previousEye=new THREE.Vector3(Infinity,0,0), previousRotation=new THREE.Quaternion();
  return {
    texture:target.texture,matrix,enabled,strength,puffSoftness,
    attach(root: THREE.Group){group.add(root);previous=-Infinity;},
    get captures(){return captures;},
    get resolution(){return [target.width,target.height];},
    setQuality(value:boolean){if(high!==value)previous=-Infinity;high=value;},
    setEnabled(value:boolean){strength.value=value?1:0;if(value)previous=-Infinity;else enabled.value=0;},
    setPuffSoftness(value:boolean){puffSoftness.value=value?1:0;previous=-Infinity;},
    update(scene:THREE.Scene,view:THREE.PerspectiveCamera,time:number,force=false) {
      if(!renderer || strength.value===0 || view.position.y<=0.1){enabled.value=0;return;}
      const hz=high?OBJECT_REFLECTION.highHz:OBJECT_REFLECTION.lowHz;
      if(!force && enabled.value && time>=previous && time-previous<1/hz-1e-6 && previousEye.distanceTo(view.position)<20
        && previousRotation.angleTo(view.quaternion)<.06) return;
      mirrorWaterCamera(view,camera);
      renderer.getDrawingBufferSize(size);
      const scale=Math.min(.5,(high?OBJECT_REFLECTION.highSize:OBJECT_REFLECTION.lowSize)/Math.max(size.x,size.y));
      target.setSize(Math.max(1,Math.round(size.x*scale)),Math.max(1,Math.round(size.y*scale)));
      scene.updateMatrixWorld();
      const objects=new Set(waterReflectables(scene));
      for(const [source,clone] of pairs) if(!objects.has(source)){group.remove(clone);pairs.delete(source);puffMaterials.get(source)?.dispose();puffMaterials.delete(source);}
      for(const source of objects) {
        let clone=pairs.get(source);
        if(!clone){clone=source.clone(false);clone.matrixAutoUpdate=false;clone.castShadow=false;group.add(clone);pairs.set(source,clone);}
        clone.matrix.copy(source.matrixWorld);clone.matrixWorldNeedsUpdate=true;clone.renderOrder=source.renderOrder;
        clone.frustumCulled=source.frustumCulled;
        if((source as THREE.Mesh).isMesh){
          const mesh=source as THREE.Mesh;
          (clone as THREE.Mesh).geometry=mesh.geometry;
          if(/^puff-\d+$/.test(source.name) && (mesh.material as any).fragmentNode){
            let material=puffMaterials.get(source);
            if(!material){
              const original=(mesh.material as any).fragmentNode;
              material=(mesh.material as THREE.Material).clone();
              // Separate material graph, shared density textures/uniforms. The
              // sky cloud remains opaque; only its water image is attenuated.
              (material as any).fragmentNode=T.Fn(()=>{
                const result=original.toVar();
                const range=T.length(T.positionWorld.sub(T.cameraPosition));
                const visibility=T.smoothstep(1000,1750,range).oneMinus().mul(0.38);
                return T.vec4(result.rgb,result.a.mul(T.mix(1,visibility,puffSoftness)));
              })();
              puffMaterials.set(source,material);
            }
            (clone as THREE.Mesh).material=material;
          }else (clone as THREE.Mesh).material=mesh.material;
        }
        if((source as THREE.Light).isLight){
          const light=source as THREE.Light, copy=clone as THREE.Light;
          copy.color.copy(light.color);copy.intensity=light.intensity;
          if((source as THREE.HemisphereLight).isHemisphereLight)(copy as THREE.HemisphereLight).groundColor.copy((source as THREE.HemisphereLight).groundColor);
          if((source as THREE.DirectionalLight).isDirectionalLight){
            (copy as THREE.DirectionalLight).target.position.copy((source as THREE.DirectionalLight).target.getWorldPosition(new THREE.Vector3()));
            (copy as THREE.DirectionalLight).target.updateMatrixWorld();
          }
        }
      }
      const oldTarget=renderer.getRenderTarget(), face=renderer.getActiveCubeFace(), mip=renderer.getActiveMipmapLevel();
      const mrt=renderer.getMRT(), auto=renderer.autoClear, alpha=renderer.getClearAlpha(), xr=renderer.xr.enabled;
      renderer.getClearColor(clear);
      try {
        renderer.xr.enabled=false;renderer.autoClear=true;renderer.setMRT(null);renderer.setClearColor(0,0);renderer.setRenderTarget(target);
        renderer.render(capture,camera);
        matrix.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
        enabled.value=1;previous=time;captures++;previousEye.copy(view.position);previousRotation.copy(view.quaternion);
      } finally {
        renderer.setRenderTarget(oldTarget,face,mip);renderer.setMRT(mrt);renderer.setClearColor(clear,alpha);renderer.autoClear=auto;renderer.xr.enabled=xr;
      }
    },
    dispose(){target.dispose();capture.clear();pairs.clear();for(const material of puffMaterials.values())material.dispose();puffMaterials.clear();},
  };
}
