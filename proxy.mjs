#!/usr/bin/env node
/**
 * proxy.mjs -- bridge the SDK's proof-server expectations to a hosted endpoint.
 *
 * Two jobs, both needed for Arkhia ZKPaas:
 *
 * 1. PATH REWRITE. midnight-js-http-client-proof-provider@4.1.1 hardcodes POST
 *    '/prove'. Arkhia's proof server (8.1.0) does not expose that route -- it
 *    answers Express's `Cannot POST /prove`, which the SDK surfaces only as the
 *    useless "Failed to prove transaction". Our local server (7.0.0-rc.1) has
 *    both /prove and /prove-tx, which is why local works and hosted does not.
 *    So /prove is rewritten to /prove-tx on the way out.
 *
 * 2. AUTH. Arkhia accepts the API key IN THE PATH, which the SDK cannot do (it
 *    takes no header or URL hook). The upstream base therefore already contains
 *    the key, and x-api-secret is added as a header when set.
 *
 * The key is a live credential: it is never logged, and the startup banner
 * prints only the shape of the URL.
 *
 *   MN_PROOF_UPSTREAM="https://starter.arkhia.io/midnight/zkpaas/preprod/$KEY/" \
 *   ARKHIA_API_SECRET=... node proxy.mjs
 *   # then: MN_PROOF_SERVER=http://127.0.0.1:6301/
 */
import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const UPSTREAM = process.env.MN_PROOF_UPSTREAM;
const SECRET = process.env.ARKHIA_API_SECRET;
const KEY = process.env.ARKHIA_API_KEY;
const PORT = Number(process.env.PROXY_PORT ?? 6301);
// Rewrites, as "from=to" pairs. Default bridges the 4.1.1 SDK to an 8.1.0 server.
const REWRITES = Object.fromEntries(
  (process.env.MN_PROOF_PATH_REWRITE ?? '/prove=/prove-tx')
    .split(',').filter(Boolean).map((p) => p.split('=')),
);

if (!UPSTREAM) {
  console.error('MN_PROOF_UPSTREAM not set (include the API key in the path if Arkhia)');
  process.exit(1);
}
const up = new URL(UPSTREAM);
const redact = (s) => (KEY ? s.split(KEY).join('${KEY}') : s);

const server = http.createServer((req, res) => {
  const base = up.pathname.replace(/\/$/, '');
  const incoming = req.url.split('?')[0];
  const mapped = REWRITES[incoming] ?? incoming;
  const path = base + mapped + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
  if (mapped !== incoming) console.log(`  rewrite ${incoming} -> ${mapped}`);

  const headers = { ...req.headers, host: up.hostname };
  delete headers['content-length'];      // body is streamed; let it re-chunk
  if (SECRET) headers['x-api-secret'] = SECRET;

  const upstreamReq = httpsRequest({
    protocol: up.protocol, hostname: up.hostname, port: up.port || 443,
    method: req.method, path, headers,
  }, (upstreamRes) => {
    if (upstreamRes.statusCode >= 400) {
      console.log(`  ${req.method} ${mapped} -> ${upstreamRes.statusCode}`);
    }
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', (e) => {
    console.error('upstream error:', e.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('proxy upstream error');
  });
  req.pipe(upstreamReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`proof proxy on http://127.0.0.1:${PORT}/`);
  console.log(`  upstream : ${redact(UPSTREAM)}`);
  console.log(`  rewrites : ${JSON.stringify(REWRITES)}`);
  console.log(`  x-api-secret: ${SECRET ? 'attached' : 'not set'}`);
  console.log(`  point MN_PROOF_SERVER at http://127.0.0.1:${PORT}/`);
});
