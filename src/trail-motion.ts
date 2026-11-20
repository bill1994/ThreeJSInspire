/** Continuous, birth-anchored drift. Shared wind plus a small wing-specific phase. */
export const TRAIL_LIFE = 1.6;
export const WAKE_LIFE = 0.9;
export interface TrailProfile { lateral:number; lift:number; width:number; alpha:number }
export function trailProfile(born:number,age:number,wing:number,out:TrailProfile):void {
  const a=Math.max(0,age),growth=Math.min(a/.65,1);
  out.lateral=1.1*growth*growth*(.7*Math.sin(born*2.1+a*.4)+.3*Math.sin(born*4.3+.8+wing*.7));
  out.lift=.28*growth*growth*Math.sin(born*1.2+a*.7+wing*.5);
  out.width=(1+.8*Math.min(a/TRAIL_LIFE,1))*(.85+.15*Math.sin(born*3+wing*.6));
  out.alpha=Math.max(0,1-a/TRAIL_LIFE)**2*(.85+.15*Math.sin(born*2.4+.9+wing*.3));
}

/** Foam stays on the water. Birth-anchored gaps travel with each deposited patch. */
export function wakeProfile(born:number,age:number,out:TrailProfile):void {
  const a=Math.max(0,age),t=Math.min(a/WAKE_LIFE,1);
  const growth=Math.min(a/.4,1);
  const wave=.5+.35*Math.sin(born*9)+.15*Math.sin(born*19+2);
  const gap=Math.max(0,Math.min(1,(wave-.28)/.44));
  out.lateral=.55*growth*growth*(.7*Math.sin(born*3.1+a*.35)+.3*Math.sin(born*7.7+1.4));
  out.lift=0;
  out.width=(1+.65*t)*(.8+.2*Math.sin(born*5.3+.6));
  out.alpha=.52*(1-t)**2*gap*gap*(3-2*gap);
}
