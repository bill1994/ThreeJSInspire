import * as THREE from 'three';

const SIDE = 96, CELL = 1.5, STEP = 1 / 30;
type Pose = {x:number; z:number; skim?:number; yaw?:number; floats?:import('../surface-interaction').FloatPair};

/** Camera-independent rolling grid. Integer shifts preserve waves in world space. */
export class SkimField {
  readonly origin = new THREE.Vector2();
  readonly span = SIDE * CELL;
  private height = new Float32Array(SIDE * SIDE);
  private previous = new Float32Array(SIDE * SIDE);
  private blocked = new Uint8Array(SIDE * SIDE);
  private scratch = new Float32Array(SIDE * SIDE);
  private pixels = new Uint8Array(SIDE * SIDE * 4);
  readonly texture = new THREE.DataTexture(this.pixels, SIDE, SIDE);
  private remaining = 0;
  private accumulator = 0;
  private lastX = NaN;
  private lastZ = NaN;

  constructor() {
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  private shift(x:number,z:number,ground?: (x:number,z:number)=>number) {
    const ox = (Math.floor(x / CELL) - SIDE / 2) * CELL;
    const oz = (Math.floor(z / CELL) - SIDE / 2) * CELL;
    const dx = Math.round((ox-this.origin.x)/CELL), dz = Math.round((oz-this.origin.y)/CELL);
    if (!dx && !dz && Number.isFinite(this.lastX)) return;
    const reset = !Number.isFinite(this.lastX) || Math.abs(dx)>=SIDE || Math.abs(dz)>=SIDE;
    for (const buffer of [this.height,this.previous,this.blocked]) {
      this.scratch.set(buffer);
      for(let j=0;j<SIDE;j++) for(let i=0;i<SIDE;i++){
        const a=i+dx,b=j+dz;
        buffer[i+j*SIDE]=!reset && a>=0 && a<SIDE && b>=0 && b<SIDE ? this.scratch[a+b*SIDE]
          : buffer===this.blocked && ground && ground(ox+(i+.5)*CELL,oz+(j+.5)*CELL)>0 ? 1 : 0;
      }
    }
    if (reset) this.lastX=NaN;
    this.origin.set(ox,oz);
  }

  update(dt:number,pose:Pose,ground?: (x:number,z:number)=>number) {
    const strength=pose.floats ? Math.max(pose.floats[0].strength, pose.floats[1].strength) : pose.skim ?? 0;
    if (strength>.08) this.remaining=2.2;
    if (this.remaining<=0 || dt<=0) return;
    this.remaining=Math.max(0,this.remaining-dt);
    this.accumulator+=Math.min(.1,dt);
    if(this.accumulator<STEP && this.remaining>0)return;
    this.shift(pose.x,pose.z,ground);
    const dx=Number.isFinite(this.lastX)?pose.x-this.lastX:0;
    const dz=Number.isFinite(this.lastX)?pose.z-this.lastZ:0;
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/CELL));
    const yaw=pose.yaw??0;
    for(let n=1;n<=steps && strength>.08;n++) for(const side of [-1,1]){
      const source = pose.floats?.[side < 0 ? 0 : 1];
      const amount = source?.strength ?? strength;
      if (amount <= .08) continue;
      const x=(source?.x ?? pose.x+Math.cos(yaw)*side*2.4)-dx*(1-n/steps);
      const z=(source?.z ?? pose.z-Math.sin(yaw)*side*2.4)-dz*(1-n/steps);
      const i=Math.floor((x-this.origin.x)/CELL),j=Math.floor((z-this.origin.y)/CELL);
      if(i>0 && i<SIDE-1 && j>0 && j<SIDE-1 && !this.blocked[i+j*SIDE])this.height[i+j*SIDE]=amount*.65;
    }
    this.lastX=pose.x;this.lastZ=pose.z;
    while(this.accumulator>=STEP){
      this.accumulator-=STEP;
      for(let j=1;j<SIDE-1;j++)for(let i=1;i<SIDE-1;i++){
        const k=i+j*SIDE,h=this.height[k];
        const lap=this.height[k-1]+this.height[k+1]+this.height[k-SIDE]+this.height[k+SIDE]-4*h;
        this.previous[k]=this.blocked[k]?0:(h+(h-this.previous[k])*.965+.32*lap)*.991;
      }
      [this.height,this.previous]=[this.previous,this.height];
    }
    this.pixels.fill(0);
    if(this.remaining>0){
      // Keep the rim level when bilinear sampling mixes it with interior texels.
      for (let i = 0; i < SIDE; i++) {
        for (const k of [i, (SIDE - 1) * SIDE + i, i * SIDE, i * SIDE + SIDE - 1]) {
          this.pixels[k * 4] = this.pixels[k * 4 + 1] = 128;
        }
      }
      for(let j=1;j<SIDE-1;j++)for(let i=1;i<SIDE-1;i++){
        const k=i+j*SIDE,p=k*4;
        this.pixels[p]=128+Math.round(90*THREE.MathUtils.clamp(this.height[k+1]-this.height[k-1],-1,1));
        this.pixels[p+1]=128+Math.round(90*THREE.MathUtils.clamp(this.height[k+SIDE]-this.height[k-SIDE],-1,1));
        this.pixels[p+3]=this.blocked[k]?0:255;
      }
    }else{this.lastX=NaN;this.accumulator=0;}
    this.texture.needsUpdate=true;
  }
}
