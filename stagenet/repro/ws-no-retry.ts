// Defect under test: "a single refused WebSocket permanently retires a wallet".
// wallet-sdk-indexer-client builds graphql-ws with `shouldRetry: () => false`;
// the question is whether anything ABOVE it reconnects. A THROWAWAY wallet is
// pointed at a local WebSocket endpoint and the SDK's connection attempts are
// counted over OBSERVE_S seconds.
//
//   MODE=close       accept, then close immediately (default)
//   MODE=refuse      nothing listening: TCP connection refused
//   MODE=403         reject the HTTP upgrade with 403 (what the rate limiter does)
//   MODE=drop:20     proxy to the real indexer for 20 s, then close everything
//                    and refuse from then on (a mid-session drop, like a 403)
//
// Expected with the defect: initial attempts, then silence. Expected without
// it: a reconnection schedule (the 2.0 stack shows 1, 2, 4, 8, 16 s…).
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

const OBSERVE_S = Number(process.env.OBSERVE_S ?? 30);
const MODE = process.env.MODE ?? 'close';
const dropAfter = MODE.startsWith('drop:') ? Number(MODE.slice(5)) : null;
const upstream = process.env.MN_INDEXER_WS ?? 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';
const attempts: number[] = [];
const t0 = Date.now();
let port: number;
let dropped = false;
const live = new Set<WebSocket>();

if (MODE === 'refuse') {
  const srv = createServer(); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  port = (srv.address() as any).port; srv.close();                    // port known to be closed
  console.log(`nothing listening on 127.0.0.1:${port}: every connect is refused`);
} else {
  const wss = new WebSocketServer({
    host: '127.0.0.1', port: 0, handleProtocols: (p) => [...p][0] ?? false,
    verifyClient: (_info: any, cb: (ok: boolean, code?: number, msg?: string) => void) => {
      if (MODE === '403') { attempts.push(Date.now() - t0); cb(false, 403, 'repro: rate limited'); } else cb(true);
    },
  });
  wss.on('connection', (sock, req) => {
    attempts.push(Date.now() - t0);
    if (dropAfter === null || dropped) { sock.close(1011, 'repro: refusing'); return; }
    const up = new WebSocket(upstream, sock.protocol ? [sock.protocol] : undefined);
    live.add(sock); live.add(up);
    up.on('open', () => sock.on('message', (m, bin) => up.send(m, { binary: bin })));
    up.on('message', (m, bin) => sock.readyState === sock.OPEN && sock.send(m, { binary: bin }));
    const closeBoth = () => { try { sock.close(); } catch {} try { up.close(); } catch {} live.delete(sock); live.delete(up); };
    up.on('close', closeBoth); up.on('error', closeBoth); sock.on('close', closeBoth); sock.on('error', closeBoth);
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  port = (wss.address() as any).port;
  console.log(`fake indexer WebSocket on 127.0.0.1:${port}, mode=${MODE}`);
  if (dropAfter !== null) setTimeout(() => { dropped = true; console.log(`  dropping ${live.size} live sockets at ${((Date.now() - t0) / 1000).toFixed(1)}s; refusing from now on`); for (const s of live) { try { s.close(1011, 'repro: dropped'); } catch {} } live.clear(); }, dropAfter * 1000);
}
process.env.MN_INDEXER_WS = `ws://127.0.0.1:${port}/api/v4/graphql/ws`;

const { buildWallet, firstState } = await import('../src/wallet.js');      // reads MN_INDEXER_WS at import
const b = await buildWallet(randomBytes(32).toString('hex'));           // throwaway seed, never funded
await new Promise((r) => setTimeout(r, OBSERVE_S * 1000));
const st = await firstState(b.wallet);
const conn = ['shielded', 'unshielded', 'dust'].map((k) => `${k}=${st?.[k]?.progress?.isConnected ?? '?'}`).join(' ');
const after = dropAfter ?? 5;
const late = attempts.filter((ms) => ms > after * 1000);
console.log(`connection attempts in ${OBSERVE_S}s: ${attempts.length}${MODE === 'refuse' ? ' (TCP refusals are not observable here; see isConnected)' : ''} at ${attempts.map((ms) => (ms / 1000).toFixed(1) + 's').join(', ')}`);
console.log(`isConnected after ${OBSERVE_S}s: ${conn}`);
b.wallet.stop().catch(() => {});
const { result } = await import('./_common.js');
if (MODE === 'refuse') result('ws-no-retry', 'SKIPPED', `refuse mode only reports state: ${conn}`);
else if (attempts.length > 0 && late.length === 0) result('ws-no-retry', 'REPRODUCED', `${attempts.length} connect(s) before ${after}s, zero reconnection attempts in the following ${OBSERVE_S - after}s (${conn})`);
else if (attempts.length === 0) result('ws-no-retry', 'SKIPPED', 'the SDK never opened the subscription socket');
else result('ws-no-retry', 'NOT REPRODUCED', `${late.length} reconnection attempt(s) after ${after}s: ${late.map((ms) => (ms / 1000).toFixed(0) + 's').join(', ')} — the sync layer does retry (${conn})`);
