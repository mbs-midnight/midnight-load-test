#!/usr/bin/env node
/**
 * indexer_proxy.mjs -- inject the rate-limit bypass header into indexer and node
 * traffic that the SDK cannot add headers to itself.
 *
 * WHY THIS EXISTS. The wallet SDK's indexer client and Polkadot node client take
 * no header hook, so a bypass token we hold cannot reach them. Measured: at only
 * ~0.5 tx/s aggregate, 57% of submissions failed with `Forbidden`, and a single
 * refused WebSocket is unrecoverable because wallet-sdk-indexer-client builds its
 * graphql-ws client with `shouldRetry: () => false`.
 *
 * WEBSOCKETS ARE THE POINT. Wallet sync is a graphql-ws subscription, so an
 * HTTP-only proxy would fix nothing -- the sync path is exactly what gets
 * throttled. This proxies both, forwarding the header on the WS *handshake*
 * (where headers are allowed) and then piping frames verbatim.
 *
 * Ports (defaults):
 *   6310 -> https://indexer.preview.midnight.network   (HTTP + WS upgrade)
 *   6311 -> wss://rpc.preview.midnight.network         (node RPC, WS)
 *
 * Then point the harness at the proxies:
 *   MN_INDEXER_HTTP=http://127.0.0.1:6310/api/v4/graphql
 *   MN_INDEXER_WS=ws://127.0.0.1:6310/api/v4/graphql/ws
 *   MN_NODE_RPC=ws://127.0.0.1:6311
 *
 * The token is read from the environment and never logged.
 */
import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';

const BYPASS = (process.env.MN_RATELIMIT_BYPASS ?? '').trim();
const HEADER = process.env.MN_RATELIMIT_HEADER ?? 'x-shielded-ratelimit-bypass';
const INDEXER_UP = process.env.MN_PROXY_INDEXER ?? 'https://indexer.preview.midnight.network';
const NODE_UP = process.env.MN_PROXY_NODE ?? 'wss://rpc.preview.midnight.network';
const INDEXER_PORT = Number(process.env.MN_PROXY_INDEXER_PORT ?? 6310);
const NODE_PORT = Number(process.env.MN_PROXY_NODE_PORT ?? 6311);

if (!BYPASS) console.warn('WARNING: MN_RATELIMIT_BYPASS not set -- proxying WITHOUT the bypass header');
const extra = BYPASS ? { [HEADER]: BYPASS } : {};
const stats = { http: 0, ws: 0, wsErr: 0, httpErr: 0 };

// ---------------------------------------------------------------- HTTP ----
function makeHttpProxy(upstreamUrl, port, label) {
  const up = new URL(upstreamUrl);
  const server = http.createServer((req, res) => {
    stats.http++;
    // Nagle batches small writes for up to ~40ms. On the sync path that delay
    // is enough to make a dust spend proof stale by the time it is submitted
    // (observed: proxying the indexer WS turned 0 dust errors into 44 x code
    // 170). Disable it on every hop.
    req.socket.setNoDelay(true);
    res.socket?.setNoDelay?.(true);
    const headers = { ...req.headers, host: up.hostname, ...extra };
    delete headers['content-length'];
    const r = httpsRequest({
      protocol: 'https:', hostname: up.hostname, port: 443,
      method: req.method, path: req.url, headers,
    }, (ur) => {
      if ((ur.statusCode ?? 0) >= 400) {
        stats.httpErr++;
        console.log(`  [${label}] ${req.method} ${req.url.slice(0, 40)} -> ${ur.statusCode}`);
      }
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    r.on('error', (e) => {
      stats.httpErr++;
      if (!res.headersSent) res.writeHead(502);
      res.end(`proxy error: ${e.message}`);
    });
    req.pipe(r);
  });

  // WebSocket upgrade: the header goes on the HANDSHAKE, then frames pipe through.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.setNoDelay(true);
    wss.handleUpgrade(req, socket, head, (client) => {
      stats.ws++;
      const target = `wss://${up.hostname}${req.url}`;
      // graphql-ws negotiates a subprotocol; it must be carried across or the
      // server closes the socket immediately.
      const protos = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const upstream = new WebSocket(target, protos.length ? protos : undefined, { headers: extra });
      upstream.on('upgrade', (r) => r.socket?.setNoDelay?.(true));
      try { client._socket?.setNoDelay?.(true); } catch { /* best effort */ }
      const q = [];
      let open = false;
      upstream.on('open', () => { open = true; for (const m of q) upstream.send(m); q.length = 0; });
      upstream.on('message', (d, bin) => { if (client.readyState === 1) client.send(d, { binary: bin }); });
      upstream.on('close', (c, r) => { try { client.close(c >= 1000 && c <= 4999 ? c : 1011, r); } catch {} });
      upstream.on('error', (e) => { stats.wsErr++; console.log(`  [${label}] WS upstream error: ${e.message}`); try { client.close(1011); } catch {} });
      client.on('message', (d, bin) => { open ? upstream.send(d, { binary: bin }) : q.push(d); });
      client.on('close', () => { try { upstream.close(); } catch {} });
      client.on('error', () => { try { upstream.close(); } catch {} });
    });
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`  ${label}: http://127.0.0.1:${port}  ws://127.0.0.1:${port}  -> ${upstreamUrl}`));
}

makeHttpProxy(INDEXER_UP, INDEXER_PORT, 'indexer');
makeHttpProxy(NODE_UP.replace(/^wss:/, 'https:'), NODE_PORT, 'node');

console.log(`bypass header: ${BYPASS ? `${HEADER} ATTACHED` : 'NOT SET'}`);
setInterval(() => {
  console.log(`  [stats] http=${stats.http} (err ${stats.httpErr})  ws=${stats.ws} (err ${stats.wsErr})`);
}, 60_000).unref?.();
