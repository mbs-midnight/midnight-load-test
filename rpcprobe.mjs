import { WebSocket } from 'ws';
const URL = 'wss://rpc.preview.midnight.network';
const ws = new WebSocket(URL);
let id = 0; const pending = new Map();
const call = (method, params = []) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 12000);
});
ws.on('message', (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
ws.on('close', (c, r) => console.log(`WS CLOSED code=${c} reason=${r}`));
ws.on('open', async () => {
  console.log('WS connected to', URL);
  for (const [m, p] of [['system_chain',[]], ['system_name',[]], ['system_version',[]], ['system_health',[]]]) {
    try { console.log(`  ${m}:`, JSON.stringify(await call(m, p))); }
    catch (e) { console.log(`  ${m}: FAILED ${e.message}`); }
  }
  // Which submission methods does this node expose?
  try {
    const methods = await call('rpc_methods');
    const all = methods?.methods ?? [];
    console.log('  midnight/author methods:', all.filter((x) => /midnight|author_submit/i.test(x)).join(', ') || '(none)');
  } catch (e) { console.log('  rpc_methods FAILED', e.message); }
  ws.close(); process.exit(0);
});
