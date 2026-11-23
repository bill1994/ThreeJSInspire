import { distantBankPlacement, DISTANT_BANK_COUNT, upperCloudPlacement, UPPER_CLOUD_COUNT } from './cloud-composition';
/** World-anchored distant cloud cards. Baking stays independent of flight. */
import * as THREE from 'three';
import { skyColorTsl } from './sky-webgpu';
import { CloudArrivalGate, OffscreenCloudGate, cloudViewTest } from './cloud-arrival';
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
  silhouette?: CloudLayout['silhouette'];
  ink?: {w:number;h:number};
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
  return { kind: c.kind, silhouette:c.silhouette, center, forward, right, up, halfWidth, halfHeight, distance };
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

// Intervals are expressed in radians around the live eye. Longitude wraps at π.
export interface SkyBounds { az:number; el:number; w:number; h:number }
export function skyEdgeGap(a:SkyBounds,b:SkyBounds) {
  const da=Math.abs(Math.atan2(Math.sin(a.az-b.az),Math.cos(a.az-b.az)));
  return Math.max((da-a.w-b.w)*Math.cos(Math.min(Math.abs(a.el),Math.abs(b.el))),
    Math.abs(a.el-b.el)-a.h-b.h);
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
    const bounds:SkyBounds={az:0,el:0,w:0,h:0};
    mesh.userData.skyBounds=bounds;
    return {tile,mesh,material,opacity,sample,bounds};
  };
  function worldHalfWidth(tile:NonNullable<BgCumulusHandles['tiles']>[number]) {
    const scale=composed?(tile.kind==='tower'?BG_COMPOSITION.towerScale:BG_COMPOSITION.midScale):1;
    const width=tile.halfWidth*BG_FIELD.scale*scale;
    if(!composed || !relaxed || !tile.silhouette) return width;
    // Reserve an identifiable sky sector without a single split bank swallowing its neighbours.
    return Math.min(width*1.25,tile.distance*BG_FIELD.scale*.46/(tile.ink?.w??1));
  }
  const cards=(rig.tiles ?? []).map((tile,index)=>{
    const card=makeCard(tile,index);
    group.add(card.mesh);
    const spot:BgFieldSpot={x:tile.center.x*BG_FIELD.scale,y:70+(tile.center.y-70)*BG_FIELD.scale,z:tile.center.z*BG_FIELD.scale,age:BG_FIELD.fadeSeconds,generation:0};
    card.mesh.userData.world=spot;
    const halfWidth=worldHalfWidth(tile);
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
    Object.assign(card.bounds,{az:placement.azimuth,el:placement.elevation,
      w:Math.atan(Math.tan(placement.halfAngle)*(card.tile.ink?.w??1))/Math.cos(placement.elevation),
      h:Math.atan(card.mesh.scale.y*(card.tile.ink?.h??1)/BG_FIELD.displayRadius)});
    return {...card,direction,placement};
  }) : [];
  let lastTime:number|undefined;
  let previous:THREE.Vector3|undefined;
  const delta=new THREE.Vector3();
  const arrivals = new CloudArrivalGate();
  const prepared = new OffscreenCloudGate();
  let firstView = true;
  let layoutReady = false;
  let lastView: THREE.PerspectiveCamera | undefined;
  type Card = typeof cards[number];
  const accent=(c:Card)=>!c.spot.upper && !!c.tile.silhouette;
  const measure=(c:Card,eye:THREE.Vector3)=>{
    const x=c.spot.x-eye.x,z=c.spot.z-eye.z,y=c.spot.y-eye.y,radial=Math.hypot(x,z);
    const distance=Math.max(1,Math.hypot(radial,y));
    c.bounds.az=Math.atan2(x,-z); c.bounds.el=Math.atan2(y,radial);
    c.bounds.w=Math.atan2(c.halfWidth*(c.tile.ink?.w??1),Math.max(1,radial));
    c.bounds.h=Math.atan2(c.halfHeight*(c.tile.ink?.h??1),distance);
    c.mesh.userData.silhouette=c.spot.upper?undefined:c.tile.silhouette;
  };
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
      // Update every final position and replacement tile before admitting any neighbour.
      const fresh:Card[]=[];
      for(const [index,card] of cards.entries()) {
        const {spot,mesh}=card;
        const moved=updateBgSpot(spot,camera,index,dt,reset);
        if(moved) {
          arrivals.reset(mesh); prepared.reset(mesh);
          const pool=(rig.tiles??[]).filter(t=>t.kind===card.tile.kind &&
            (spot.upper || Boolean(t.silhouette)===Boolean(card.tile.silhouette)));
          const next=pool[(index+spot.generation)%pool.length];
          if(next) {
            if(!spot.upper) card.halfWidth=worldHalfWidth(next);
            card.tile=next; card.sample.value=next.texture;
            card.halfHeight=card.halfWidth*next.halfHeight/next.halfWidth;
          }
        }
        measure(card,camera);
        if(relaxed && accent(card) && (!layoutReady || moved)) fresh.push(card);
      }
      // Reorient only at first placement or behind the recycling fog, before admission.
      if(fresh.length) {
        const reserved=cards.filter(c=>!fresh.includes(c) && gate.active(c.mesh) && c.mesh.visible);
        fresh.sort((a,b)=>b.bounds.w-a.bounds.w);
        for(const card of fresh) {
          const initial=card.bounds.az, spot=card.spot;
          const radial=Math.hypot(spot.x-camera.x,spot.z-camera.z);
          for(let k=0;k<65;k++) {
            const turn=Math.ceil(k/2)*(k%2?1:-1)*Math.PI/32;
            const az=initial+turn;
            spot.x=camera.x+Math.sin(az)*radial; spot.z=camera.z-Math.cos(az)*radial;
            measure(card,camera);
            if(reserved.every(c=>skyEdgeGap(card.bounds,c.bounds)>.02+.18*Math.max(card.bounds.w,c.bounds.w))) break;
          }
          reserved.push(card);
        }
      }
      layoutReady=true;
      const distances=cards.map(({spot})=>Math.hypot(spot.x-camera.x,spot.y-camera.y,spot.z-camera.z));
      const order=cards.map((_,i)=>i).sort((a,b)=>distances[b]-distances[a]);
      order.forEach((index,rank)=>{cards[index].mesh.renderOrder=-900+rank;});
      if(relaxed) order.sort((a,b)=>Number(accent(cards[b]))-Number(accent(cards[a])));
      for(const index of order) {
        const card=cards[index],{spot,mesh,opacity,halfWidth,halfHeight}=card;
        delta.set(spot.x,spot.y,spot.z).sub(camera);
        const distance=Math.max(1,delta.length());
        const factor=BG_FIELD.displayRadius/distance;
        mesh.position.copy(camera).addScaledVector(delta,factor);
        mesh.scale.set(halfWidth*factor,halfHeight*factor,1);
        mesh.lookAt(camera);
        opacity.value=bgDistanceOpacity(bgSpotDistance(spot,camera))*smooth(0,BG_FIELD.fadeSeconds,spot.age);
        if (relaxed) {
          const rect=card.bounds;
          const clear=gate.active(mesh) || cards.every(other=>{
            if(other===card || !gate.active(other.mesh)) return true;
            const neighbour=other.bounds;
            const margin=.012+.16*Math.max(rect.w*Math.cos(rect.el),neighbour.w*Math.cos(neighbour.el));
            return skyEdgeGap(rect,neighbour)>margin &&
              Math.hypot(spot.x-other.spot.x,spot.y-other.spot.y,spot.z-other.spot.z)>
              halfWidth*(card.tile.ink?.w??1)+other.halfWidth*(other.tile.ink?.w??1);
          });
          opacity.value = outside
            ? prepared.update(mesh,opacity.value,clear,
                outside(new THREE.Vector3(spot.x,spot.y,spot.z),Math.hypot(halfWidth,halfHeight)),firstView)
            : arrivals.update(mesh, opacity.value, dt, clear);
        }
        mesh.visible=opacity.value>0;
        mesh.userData.opacity=opacity.value;
        mesh.userData.cloudPrepared=gate.active(mesh);
      }
      // Lateral flight can close an admitted gap. Fade the lower-priority card
      // through haze before its silhouette reaches an accent, keeping both anchored.
      if(relaxed) for(let i=0;i<cards.length;i++) {
        const card=cards[i];
        if(!card.mesh.visible) continue;
        for(let j=0;j<cards.length;j++) {
          const large=cards[j];
          if(!accent(large) || !large.mesh.visible || (accent(card) && j>=i)) continue;
          const margin=.02+.16*large.bounds.w*Math.cos(large.bounds.el);
          card.opacity.value*=smooth(margin,margin+.06,skyEdgeGap(card.bounds,large.bounds));
        }
        card.mesh.visible=card.opacity.value>.001;
        card.mesh.userData.opacity=card.opacity.value;
      }
      if(relaxed) for(const horizon of horizonCards) {
        let weight=1;
        for(const card of cards) {
          if(!accent(card) || !card.mesh.visible) continue;
          const rect=card.bounds;
          const gap=skyEdgeGap(horizon.bounds,rect);
          const margin=.02+.16*rect.w*Math.cos(rect.el);
          weight=Math.min(weight,1-smooth(0,.09,card.opacity.value)*(1-smooth(margin,margin+.065,gap)));
        }
        horizon.opacity.value=horizon.placement.opacity*weight;
        horizon.mesh.visible=weight>.001;
      }
      if(outside) firstView=false;
    },
    setVisible(value:boolean){group.visible=value;backdrop.visible=value;},
    dispose(){scene.remove(group,backdrop);geometry.dispose();[...cards,...horizonCards].forEach(c=>c.material.dispose());},
  };
}
