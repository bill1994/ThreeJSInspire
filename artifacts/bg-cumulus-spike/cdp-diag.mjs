// CDP 诊断：连接已开的 Chrome 页面，抓 console + 运行时状态（烘焙模块排障）
import { writeFileSync } from 'node:fs';

const list = await (await fetch('http://127.0.0.1:9224/json/list')).json();
const page = list.find(t => t.type === 'page' && (t.url || '').startsWith('http://localhost:5173'));
if (!page) { console.log('NO PAGE TARGET'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const consoleLines = [];
const exceptions = [];

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    consoleLines.push(`[${msg.params.type}] ${text.slice(0, 500)}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    exceptions.push(`${d.exception?.description || d.text} @ ${d.url}:${d.lineNumber}`.slice(0, 600));
  }
  if (msg.method === 'Log.entryAdded') {
    consoleLines.push(`[log.${msg.params.entry.level}] ${String(msg.params.entry.text).slice(0, 500)}`);
  }
};

ws.onerror = (e) => { console.log('WS ERROR', String(e)); process.exit(1); };

await new Promise(res => { ws.onopen = res; });
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// 刷新并等待启动
await send('Page.reload');
await new Promise(res => setTimeout(res, 1000));
// 等待 boot 完成（porco 出现或 20 秒）
let state = null;
for (let i = 0; i < 20; i++) {
  await new Promise(res => setTimeout(res, 1000));
  try {
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({ porco: !!window.__porco, boot: (document.getElementById("boot-status")||{}).textContent, adapterHint: typeof navigator.gpu })', returnByValue: true });
    state = JSON.parse(r.result.value);
    if (state.porco) break;
  } catch (e) { state = { evalErr: String(e).slice(0, 200) }; }
}

// 运行时深度诊断
let deep = null;
try {
  const r = await send('Runtime.evaluate', { expression: `
    (async () => {
      const out = {};
      out.porco = !!window.__porco;
      out.qa = typeof window.__porco?.qa?.setTod;
      out.sun = window.__porco?.qa?.getSun ? (() => { const s = window.__porco.qa.getSun(); return { az: Math.round(s.azimuthDeg), el: Math.round(s.elevationDeg) }; })() : null;
      return JSON.stringify(out);
    })()
  `, returnByValue: true, awaitPromise: true });
  deep = JSON.parse(r.result.value);
} catch (e) { deep = { err: String(e).slice(0, 300) }; }

const out = { state, deep, exceptions: exceptions.slice(0, 10), console: consoleLines.slice(0, 40) };
console.log(JSON.stringify(out, null, 1));
writeFileSync('artifacts/bg-cumulus-spike/cdp-diag-out.json', JSON.stringify(out, null, 1));
process.exit(0);
