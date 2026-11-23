import { distantBankPlacement, DISTANT_BANK_COUNT, upperCloudPlacement, UPPER_CLOUD_COUNT } from './cloud-composition';
/** World-anchored distant cloud cards. Baking stays independent of flight. */
import * as THREE from 'three';
import { skyColorTsl } from './sky-webgpu';
import { CloudArrivalGate, OffscreenCloudGate, cloudViewTest, cloudArrivalClear } from './cloud-arrival';
import type { CloudLayout } from './bg-cumulus-layout';
import type { BgCumulusHandles } from './bg-cumulus';

export const BG_FIELD = {
  scale: 1.8,
  window: 32000,
  fogStart: 10000,
  fogEnd: 14000,
  spawnMin: 14500,
  spawnMax: 15500,
  nearHidden: 1800,
  nearVisible: 3600,
  fadeSeconds: 3,
  teleport: 1600,
  displayRadius: 800,
} as const;

export interface CloudProjection {
  kind: CloudLayout['kind'];
  center: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  halfWidth: number;
  halfHeight: number;
  distance: number;
}

/** Conservative perspective rectangle around the displaced sphere union. */
export function cloudProjection(c: CloudLayout): CloudProjection {
  const origin = new THREE.Vector3(0, 70, 0);
  const center = new THREE.Vector3(c.bounds.cx, c.bounds.cy, c.bounds.cz);
  const forward = center.clone().sub(origin).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const distance = center.distanceTo(origin);
  let halfWidth = 0, halfHeight = 0;
  for (const [x,y,z,r] of c.puffs) {
    const p = new THREE.Vector3(x,y,z).sub(origin);
    const padding = r + c.scale * 2;
    const depth = Math.max(distance * 0.15, p.dot(forward) - padding);
    halfWidth = Math.max(halfWidth, (Math.abs(p.dot(right)) + padding) / depth * distance);
    halfHeight = Math.max(halfHeight, (Math.abs(p.dot(up)) + padding) / depth * distance);
  }
  return { kind: c.kind, center, forward, right, up, halfWidth, halfHeight, distance };
}

/** Permanent distant silhouettes fill angular gaps without teleporting visible
 * world clouds. The ring is world-oriented, never rotated with the view. */
export const BG_COMPOSITION = {
  backdropCount: 16,
  backdropOpacity: 0.64,
  towerScale: 0.54,
  midScale: 0.86,
} as const;

export function backdropPlacement(index: number, relaxed = false) {
  if(relaxed) return distantBankPlacement(index);
  const sector = 2 * Math.PI / BG_COMPOSITION.backdropCount;
  return {
    azimuth: index * sector + (relaxed ? 0 : 0.06 * Math.sin(index * 2.4)),
    elevation: (8 + 2.5 * Math.sin(index * 1.7)) * Math.PI / 180,
    halfAngle: (relaxed ? 12.5 : 15 + 2 * Math.sin(index * 2.1)) * Math.PI / 180,
    heightScale: 0.85 + 0.15 * Math.sin(index * 1.3),
    opacity: BG_COMPOSITION.backdropOpacity,
  };
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x-a)/(b-a)));
  return t*t*(3-2*t);
};

export function bgDistanceOpacity(distance: number): number {
  return smooth(BG_FIELD.nearHidden, BG_FIELD.nearVisible, distance)
    * (1-smooth(BG_FIELD.fogStart, BG_FIELD.fogEnd, distance));
}

export interface BgFieldSpot { x: number; y: number; z: number; age: number; generation: number; upper?: boolean }

/** Looking directly under a high cloud must not trigger the horizontal near cull. */
export function bgSpotDistance(spot:BgFieldSpot,camera:THREE.Vector3):number {
  return Math.hypot(spot.x-camera.x,spot.z-camera.z,spot.upper?spot.y-camera.y:0);
}

/** Upper clouds can share a bearing at different elevations. Compare full sky angles. */
export function upperCloudClear(a:BgFieldSpot,radius:number,
  others:readonly {spot:BgFieldSpot;radius:number}[],eye:THREE.Vector3):boolean {
  const ax=a.x-eye.x,ay=a.y-eye.y,az=a.z-eye.z,ad=Math.max(1,Math.hypot(ax,ay,az));
  return others.every(b=>{
    const bx=b.spot.x-eye.x,by=b.spot.y-eye.y,bz=b.spot.z-eye.z,bd=Math.max(1,Math.hypot(bx,by,bz));
    const angle=Math.acos(Math.max(-1,Math.min(1,(ax*bx+ay*by+az*bz)/(ad*bd))));
    return Math.hypot(a.x-b.spot.x,a.y-b.spot.y,a.z-b.spot.z)>radius+b.radius
      && angle>(Math.atan2(radius,ad)+Math.atan2(b.radius,bd))*.85+.01;
  });
}

/** No motion while visible. All replacement positions lie beyond the fog. */
export function updateBgSpot(spot: BgFieldSpot, camera: THREE.Vector3, index: number, dt: number, reset = false): boolean {
  const dx=spot.x-camera.x, dz=spot.z-camera.z;
  const distance=bgSpotDistance(spot,camera);
  const half=BG_FIELD.window/2;
  const recycle=reset || distance<=BG_FIELD.nearHidden || Math.abs(dx)>=half || Math.abs(dz)>=half;
  if(recycle) {
    spot.generation++;
    const phase=(index*0.61803398875+spot.generation*0.38196601125)%1;
    const angle=phase*Math.PI*2;
    const radius=BG_FIELD.spawnMin+(BG_FIELD.spawnMax-BG_FIELD.spawnMin)*((index*0.754877666+spot.generation*.31)%1);
    spot.x=camera.x+Math.sin(angle)*radius;
    spot.z=camera.z-Math.cos(angle)*radius;
    spot.age=0;
  } else spot.age=Math.min(BG_FIELD.fadeSeconds,spot.age+Math.max(0,Math.min(dt,.1)));
  return recycle;
}

/** The 800m render shell avoids changing the game's camera/depth range. Angular
 * position and size come from each card's real world position, not that shell. */
export async function attachBgCloudField(scene: THREE.Scene, rig: BgCumulusHandles, composed = true, relaxed = true, sunDirection = new THREE.Vector3(0,1,0)) {
  const webgpu = await import('three/webgpu');
  const tsl = await import('three/tsl');
  const { texture, uniform, vec4, vec2, uv, mix, smoothstep, normalize, positionWorld, cameraPosition } = tsl;
  const sun = uniform(sunDirection);
  const group=new THREE.Group();group.name='bg_cloud_field';scene.add(group);
  const backdrop=new THREE.Group();backdrop.name='bg_cloud_backdrop';scene.add(backdrop);
  const geometry=new THREE.PlaneGeometry(2,2);
  const makeCard = (tile: NonNullable<BgCumulusHandles['tiles']>[number], index: number) => {
    const opacity=uniform(1);
    // The bake plane's +v ray is world-up; WebGPU render targets store that
    // at the opposite row from a regular mesh's UV convention.
    const sample=texture(tile.texture,vec2(uv().x,uv().y.oneMinus()));
    const material=new webgpu.MeshBasicNodeMaterial();
    material.transparent=true; material.depthWrite=false; material.fog=false;
    // Texture is already premultiplied. Unpremultiply once, then let standard
    // blending apply the complete distance/age alpha exactly once.
    const cloudColor=sample.rgb.div(sample.a.max(.0001));
    // Atmospheric distance changes colour, not core coverage. Back-to-front
    // alpha blending now hides the rear card behind an opaque front cloud.
    const sky=skyColorTsl(tsl,normalize(positionWorld.sub(cameraPosition)),sun,false);
    material.colorNode=relaxed
      ? vec4(mix(sky,cloudColor,opacity),sample.a.mul(smoothstep(0,0.035,opacity)))
      : vec4(cloudColor,sample.a.mul(opacity));
    const mesh=new THREE.Mesh(geometry,material);mesh.name='bg_cloud_'+index;
    mesh.frustumCulled=false;
    return {tile,mesh,material,opacity,sample};
  };
  const cards=(rig.tiles ?? []).map((tile,index)=>{
    const card=makeCard(tile,index);
    group.add(card.mesh);
    const spot:BgFieldSpot={x:tile.center.x*BG_FIELD.scale,y:70+(tile.center.y-70)*BG_FIELD.scale,z:tile.center.z*BG_FIELD.scale,age:BG_FIELD.fadeSeconds,generation:0};
    card.mesh.userData.world=spot;
    const halfWidth=tile.halfWidth*BG_FIELD.scale*(composed?(tile.kind==='tower'?BG_COMPOSITION.towerScale:BG_COMPOSITION.midScale):1);
    return {...card,spot,halfWidth,halfHeight:halfWidth*tile.halfHeight/tile.halfWidth};
  });
  const smallerTiles=(rig.tiles ?? []).filter(tile=>tile.kind==='mid');
  if(composed && relaxed && smallerTiles.length) {
    for(let i=0;i<UPPER_CLOUD_COUNT;i++) {
      const tile=smallerTiles[(i*3+Math.floor(i/3))%smallerTiles.length];
      const card=makeCard(tile,cards.length);
      card.mesh.name=`bg_upper_${i}`;
      const placement=upperCloudPlacement(i);
      const spot:BgFieldSpot={x:placement.x,y:placement.y,z:placement.z,
        age:BG_FIELD.fadeSeconds,generation:0,upper:true};
      card.mesh.userData.world=spot;
      group.add(card.mesh);
      cards.push({...card,spot,halfWidth:placement.halfWidth,
        halfHeight:placement.halfWidth*tile.halfHeight/tile.halfWidth});
    }
  }
  const horizonCards = composed && smallerTiles.length ? Array.from({length:relaxed ? DISTANT_BANK_COUNT : BG_COMPOSITION.backdropCount},(_,i)=>{
    const card=makeCard(smallerTiles[(i*5+Math.floor(i/3))%smallerTiles.length],i);
    const placement=backdropPlacement(i, relaxed);
    card.mesh.name=`bg_horizon_${i}`;
    card.mesh.renderOrder=-950;
    card.opacity.value=placement.opacity;
    const direction=new THREE.Vector3(Math.sin(placement.azimuth)*Math.cos(placement.elevation),
      Math.sin(placement.elevation),-Math.cos(placement.azimuth)*Math.cos(placement.elevation));
    const halfWidth=BG_FIELD.displayRadius*Math.tan(placement.halfAngle);
    card.mesh.scale.set(halfWidth,halfWidth*card.tile.halfHeight/card.tile.halfWidth*placement.heightScale,1);
    backdrop.add(card.mesh);
    return {...card,direction};
  }) : [];
  let lastTime:number|undefined;
  let previous:THREE.Vector3|undefined;
  const delta=new THREE.Vector3();
  const arrivals = new CloudArrivalGate();
  const prepared = new OffscreenCloudGate();
  let firstView = true;
  let lastView: THREE.PerspectiveCamera | undefined;
  const footprint = (card: typeof cards[number]) => ({x: card.spot.x, z: card.spot.z,
    radius: card.halfWidth});
  return {
    update(t:number,camera:THREE.Vector3,view?:THREE.PerspectiveCamera) {
      if (view) lastView = view;
      const outside = lastView ? cloudViewTest(lastView) : null;
      const gate = outside ? prepared : arrivals;
      for(const card of horizonCards) {
        card.mesh.position.copy(camera).addScaledVector(card.direction,BG_FIELD.displayRadius);
        card.mesh.lookAt(camera);
      }
      const dt=lastTime===undefined?0:Math.max(0,t-lastTime);lastTime=t;
      arrivals.begin(dt);
      const reset=previous ? previous.distanceTo(camera)>BG_FIELD.teleport
        : Math.hypot(camera.x,camera.z)>BG_FIELD.teleport;
      if(!previous)previous=camera.clone();else previous.copy(camera);
      const distances=cards.map(({spot})=>Math.hypot(spot.x-camera.x,spot.y-camera.y,spot.z-camera.z));
      const order=cards.map((_,i)=>i).sort((a,b)=>distances[b]-distances[a]);
      for(const [rank,index] of order.entries()) {
        const {spot,mesh,opacity,halfWidth,halfHeight}=cards[index];
        const moved = updateBgSpot(spot,camera,index,dt,reset);
        if (moved) {
          arrivals.reset(mesh); prepared.reset(mesh);
          const pool = (rig.tiles ?? []).filter(tile=>tile.kind===cards[index].tile.kind);
          if(pool.length) cards[index].sample.value=pool[(index+spot.generation)%pool.length].texture;
        }
        delta.set(spot.x,spot.y,spot.z).sub(camera);
        const distance=Math.max(1,delta.length());
        const factor=BG_FIELD.displayRadius/distance;
        mesh.position.copy(camera).addScaledVector(delta,factor);
        mesh.scale.set(halfWidth*factor,halfHeight*factor,1);
        mesh.lookAt(camera);mesh.renderOrder=-900+rank;
        opacity.value=bgDistanceOpacity(bgSpotDistance(spot,camera))*smooth(0,BG_FIELD.fadeSeconds,spot.age);
        if (relaxed) {
          const others=cards.filter(c=>c.mesh!==mesh && Boolean(c.spot.upper)===Boolean(spot.upper) && gate.active(c.mesh));
          const clear = gate.active(mesh) || (spot.upper
            // Bake rectangles include substantial empty padding around the silhouette.
            ? upperCloudClear(spot,halfWidth*.7,others.map(c=>({spot:c.spot,radius:c.halfWidth*.7})),camera)
            : cloudArrivalClear(footprint(cards[index]),others.map(footprint),camera.x,camera.z));
          opacity.value = outside
            ? prepared.update(mesh,opacity.value,clear,
                outside(new THREE.Vector3(spot.x,spot.y,spot.z),Math.hypot(halfWidth,halfHeight)),firstView)
            : arrivals.update(mesh, opacity.value, dt, clear);
        }
        mesh.visible=opacity.value>0;
        mesh.userData.opacity=opacity.value;
        mesh.userData.cloudPrepared=gate.active(mesh);
      }
      if(outside) firstView=false;
    },
    setVisible(value:boolean){group.visible=value;backdrop.visible=value;},
    dispose(){scene.remove(group,backdrop);geometry.dispose();[...cards,...horizonCards].forEach(c=>c.material.dispose());},
  };
}
