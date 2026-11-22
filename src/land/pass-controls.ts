import type { PASSES } from './airflow';

function mountRouteLinks(frame: HTMLElement, title: string, parameter: string,
  options: Record<string,string>, current: string) {
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label',title);
  nav.style.cssText = 'position:absolute;bottom:max(8px,env(safe-area-inset-bottom));right:8px;z-index:11;display:flex;gap:2px;background:#253033db;border-radius:6px;padding:2px;font:13px/1.4 system-ui';
  for (const [value,label] of Object.entries(options)) {
    const link = document.createElement('a');
    const url = new URL(location.href);
    url.searchParams.delete('pos');
    url.searchParams.set(parameter,value);
    link.href = url.href;
    link.style.cssText = 'color:#fff6dc;text-decoration:none;padding:7px 9px;border-radius:4px';
    link.textContent = value === current ? '重飞' + label : label;
    if (value === current) {
      link.setAttribute('aria-current','page');
      link.style.background = '#556658';
    }
    nav.append(link);
  }
  frame.append(nav);
  return nav;
}

export function mountPassControls(frame: HTMLElement, current: keyof typeof PASSES) {
  mountRouteLinks(frame,'单岛低空试飞','pass',{grass:'草坡',canopy:'树冠',sand:'沙滩'},current);
}

export function mountMeadowControls(frame: HTMLElement, look: string) {
  mountRouteLinks(frame,'草坡对照航线','grasslook',{meadow:'上版草坡',paint:'手绘草坡'},look);
}

export function mountTreeControls(frame: HTMLElement, current: string) {
  const nav = mountRouteLinks(frame,'树形对照航线','treelook',
    {original:'原版树',coastal:'风偏阔叶树',baked:'预生成叶簇树'},current);
  nav.style.bottom = 'calc(max(8px,env(safe-area-inset-bottom)) + 40px)';
}

export function mountTreeLodControls(frame: HTMLElement, fade: boolean, hasTreeControls: boolean) {
  const nav = mountRouteLinks(frame,'远近树过渡','treelod',
    {hard:'硬切',fade:'渐变'},fade ? 'fade' : 'hard');
  nav.style.bottom = 'calc(max(8px,env(safe-area-inset-bottom)) + '+(hasTreeControls ? 80 : 40)+'px)';
}

export function mountFlightFrameProbe(frame: HTMLElement) {
  const panel = document.createElement('details');
  panel.style.cssText = 'position:absolute;top:8px;left:8px;max-width:85%;z-index:11;background:#253033ed;color:#fff6dc;border-radius:6px;padding:6px 9px;font:13px/1.5 system-ui';
  const summary = document.createElement('summary');
  summary.textContent = '首分钟采样中';
  const log = document.createElement('div');
  log.style.cssText = 'max-height:24vh;overflow:auto;white-space:pre-line;font-variant-numeric:tabular-nums';
  panel.append(summary,log);
  frame.append(panel);
  const events: string[] = [];
  let previous = NaN, previousZ = 0, elapsed = 0, worst = 0, nextLabel = 0;
  function refreshLog() {
    log.textContent = events.length ? events.join('\n') : '尚无超过 50 ms 的帧';
  }
  panel.addEventListener('toggle', () => { if (panel.open) refreshLog(); });
  document.addEventListener('visibilitychange', () => { previous = NaN; });
  return (now: number, z: number) => {
    if (document.hidden || elapsed >= 60000) return;
    if (Number.isFinite(previous)) {
      const dt = now - previous;
      if (Math.round(dt * 10) > 500) {
        events.push(`${(elapsed / 1000).toFixed(1)} 秒 · z ${Math.round(previousZ)} 米 · ${dt.toFixed(1)} ms`);
        if (panel.open) refreshLog();
      }
      worst = Math.max(worst,dt);
      elapsed += dt;
    }
    previous = now;
    previousZ = z;
    if (elapsed >= nextLabel || elapsed >= 60000) {
      summary.textContent = `${Math.min(60,Math.floor(elapsed/1000))}/60 秒 · 长帧 ${events.length} · 最长 ${Math.round(worst)} ms`;
      nextLabel = elapsed + 1000;
    }
  };
}
