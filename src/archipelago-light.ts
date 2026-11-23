// Shared world-space cloud shadows. The scalar version shades the moving aircraft.
export const atmosphere = {enabled:true, phase:0};
export function cloudLight(T:any,p:any,time:any,day:any) {
  if (!atmosphere.enabled) return T.float(1);
  const x=p.x.mul(.006).add(atmosphere.phase).sub(time.mul(.027));
  const z=p.y.mul(.0045).add(time.mul(.018));
  const cover=x.add(z.mul(.71).sin().mul(1.5)).sin().add(z.sub(x.mul(.31)).sin().mul(.65));
  return T.float(1).sub(T.smoothstep(-.55,.8,cover).mul(day).mul(.20));
}
export function airframeLight(x:number,z:number,time:number,day:number) {
  if(!atmosphere.enabled)return 1;
  const a=x*.006+atmosphere.phase-time*.027,b=z*.0045+time*.018;
  const v=Math.max(0,Math.min(1,(Math.sin(a+1.5*Math.sin(.71*b))+.65*Math.sin(b-.31*a)+.55)/1.35));
  return 1-.20*day*v*v*(3-2*v);
}
