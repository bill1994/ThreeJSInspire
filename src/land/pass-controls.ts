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
}

export function mountPassControls(frame: HTMLElement, current: keyof typeof PASSES) {
  mountRouteLinks(frame,'单岛低空试飞','pass',{grass:'草坡',canopy:'树冠',sand:'沙滩'},current);
}

export function mountMeadowControls(frame: HTMLElement, look: string) {
  mountRouteLinks(frame,'草坡对照航线','grasslook',{meadow:'上版草坡',paint:'手绘草坡'},look);
}
