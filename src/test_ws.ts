/**
 * test_ws.ts — isolate why wallet sync reports connected=false, highestIndex=0.
 *
 * Wallet sync happens over a GraphQL WebSocket subscription. The HTTP indexer
 * working (preflight [3] gets a tip) tells you nothing about the WS, and two SDK
 * details make a WS failure look like a hang rather than an error:
 *
 *   1. wallet-sdk-indexer-client calls
 *        createClient({ url, shouldRetry: () => false, keepAlive: 15_000 })
 *      with NO webSocketImpl, so graphql-ws uses globalThis.WebSocket.
 *   2. shouldRetry is FALSE, so a single failed connect is permanent -- the wallet
 *      sits at connected=false forever instead of recovering.
 *
 * This script tries the raw socket and then a real graphql-ws subscription, under
 * both the Node native WebSocket and the `ws` package, and reports which combination
 * works. Run it before touching anything else.
 *
 *   npx tsx src/test_ws.ts
 *   npx tsx src/test_ws.ts --url wss://your-indexer/api/v4/graphql/ws
 */

import { WebSocket as WsPkg } from 'ws';
import { createClient } from 'graphql-ws';

const argv = process.argv.slice(2);
const argOf = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Defaults come from providers.ts, which honours MN_NETWORK -- so `npm run test:ws`
// on preview tests PREVIEW, not a hardcoded preprod URL. A --url arg still wins.
import { INDEXER_WS as PROV_WS, INDEXER_HTTP as PROV_HTTP, NETWORK_ID } from './providers.js';
const WS_URL = argOf('url') ?? PROV_WS;
const HTTP_URL = PROV_HTTP;

// The subprotocol graphql-ws speaks. The Midnight indexer serves this on
// /graphql/ws (confirmed in indexer-api: .route("/graphql/ws", get(graphql_ws)))
// and additionally offers an opt-in deflate variant, which we do NOT request.
const SUBPROTOCOL = 'graphql-transport-ws';

const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m   ${m}`);
const bad = (m: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
const info = (m: string) => console.log(`       ${m}`);

function isWebSocketLike(val: any) {
  return (
    typeof val === 'function' &&
    'constructor' in val &&
    'CLOSED' in val &&
    'CLOSING' in val &&
    'CONNECTING' in val &&
    'OPEN' in val
  );
}

async function checkHttp() {
  console.log('\n[1] HTTP indexer (control -- proves the host and path are right)');
  try {
    const res = await fetch(HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
    });
    const doc: any = await res.json();
    const h = doc?.data?.block?.height;
    if (h != null) ok(`HTTP works, tip height ${h}`);
    else bad(`HTTP responded without a tip: ${JSON.stringify(doc).slice(0, 140)}`);
  } catch (e: any) {
    bad(`HTTP failed: ${e.message}`);
  }
}

function checkImpls() {
  console.log('\n[2] available WebSocket implementations');
  const native = (globalThis as any).WebSocket;
  if (typeof native === 'function') {
    ok(`Node native globalThis.WebSocket present (node ${process.version})`);
    info(`passes graphql-ws isWebSocket check: ${isWebSocketLike(native)}`);
  } else {
    info('no native globalThis.WebSocket -- a polyfill IS required on this Node');
  }
  info(`ws package WebSocket passes isWebSocket check: ${isWebSocketLike(WsPkg)}`);
  info('graphql-ws picks globalThis.WebSocket when webSocketImpl is not passed,');
  info('and the SDK does not pass one -- so whatever is global at import time wins.');
}

/** Raw socket open, no GraphQL. Separates transport problems from protocol ones. */
function rawConnect(Impl: any, label: string, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (good: boolean, msg: string) => {
      if (settled) return;
      settled = true;
      good ? ok(`${label}: ${msg}`) : bad(`${label}: ${msg}`);
      resolve(good);
    };
    let sock: any;
    try {
      sock = new Impl(WS_URL, SUBPROTOCOL);
    } catch (e: any) {
      return done(false, `constructor threw: ${e.message?.slice(0, 120)}`);
    }
    const timer = setTimeout(() => {
      try { sock.close(); } catch { /* ignore */ }
      done(false, `no open event within ${timeoutMs / 1000}s (silent timeout)`);
    }, timeoutMs);

    sock.onopen = () => {
      clearTimeout(timer);
      const proto = sock.protocol ?? '(none reported)';
      try { sock.close(); } catch { /* ignore */ }
      done(true, `socket opened, negotiated subprotocol: ${proto || '(empty)'}`);
    };
    sock.onerror = (ev: any) => {
      clearTimeout(timer);
      done(false, `error: ${ev?.message ?? ev?.error?.message ?? 'unknown'}`);
    };
    sock.onclose = (ev: any) => {
      if (!settled) {
        clearTimeout(timer);
        done(false, `closed before open (code ${ev?.code}, reason "${ev?.reason ?? ''}")`);
      }
    };
  });
}

/** A real graphql-ws subscription, the way the SDK does it. */
function graphqlSubscribe(Impl: any, label: string, timeoutMs = 25000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (good: boolean, msg: string) => {
      if (settled) return;
      settled = true;
      good ? ok(`${label}: ${msg}`) : bad(`${label}: ${msg}`);
      try { client.dispose(); } catch { /* ignore */ }
      resolve(good);
    };

    const client = createClient({
      url: WS_URL,
      webSocketImpl: Impl,
      shouldRetry: () => false, // mirror the SDK exactly
      keepAlive: 15_000,
      on: {
        connected: () => info(`${label}: transport connected`),
        closed: (ev: any) => {
          if (!settled) finish(false, `closed (code ${ev?.code}, reason "${ev?.reason ?? ''}")`);
        },
        error: (err: any) => finish(false, `error: ${String(err).slice(0, 160)}`),
      },
    });

    const timer = setTimeout(
      () => finish(false, `no subscription data within ${timeoutMs / 1000}s`),
      timeoutMs,
    );

    // blocks(offset:) is the subscription wallet sync relies on. Ask from a recent
    // height so the server does not stream from genesis.
    const dispose = client.subscribe(
      { query: 'subscription { blocks { height hash } }' },
      {
        next: (data: any) => {
          clearTimeout(timer);
          const h = data?.data?.blocks?.height;
          finish(true, `received a block from the subscription (height ${h ?? '?'})`);
          try { dispose(); } catch { /* ignore */ }
        },
        error: (err: any) => {
          clearTimeout(timer);
          finish(false, `subscription error: ${JSON.stringify(err).slice(0, 200)}`);
        },
        complete: () => {
          clearTimeout(timer);
          finish(false, 'subscription completed without data');
        },
      },
    );
  });
}

async function main() {
  console.log('indexer WebSocket diagnostic');
  console.log(`  network: ${NETWORK_ID}`);
  console.log(`  WS:   ${WS_URL}`);
  console.log(`  HTTP: ${HTTP_URL}`);

  await checkHttp();
  checkImpls();

  const native = (globalThis as any).WebSocket;

  console.log('\n[3] raw socket open');
  const rawNative = typeof native === 'function'
    ? await rawConnect(native, 'native WebSocket')
    : (info('skipped: no native WebSocket'), false);
  const rawWs = await rawConnect(WsPkg, 'ws package');

  console.log('\n[4] real graphql-ws subscription (what the wallet actually does)');
  const gqlNative = typeof native === 'function'
    ? await graphqlSubscribe(native, 'native WebSocket')
    : (info('skipped: no native WebSocket'), false);
  const gqlWs = await graphqlSubscribe(WsPkg, 'ws package');

  console.log('\n===== verdict =====');
  if (!rawNative && !rawWs) {
    console.log('The socket never opens with either implementation. This is transport,');
    console.log('not the SDK: wrong WS URL, TLS interception, or a firewall/proxy that');
    console.log('blocks WebSocket upgrades. Confirm the URL with your indexer operator,');
    console.log('and try from a different network before changing any code.');
  } else if ((rawNative || rawWs) && !gqlNative && !gqlWs) {
    console.log('The socket opens but the GraphQL subscription never yields data. Check');
    console.log('the subprotocol and that this indexer version exposes `blocks`.');
  } else {
    const winner = gqlNative ? 'native' : 'ws package';
    console.log(`Working combination: ${winner}.`);
    if (gqlNative && !gqlWs) {
      console.log('');
      console.log('IMPORTANT: native works and the ws package does NOT. providers.ts');
      console.log('overwrites globalThis.WebSocket with the ws package, which would break');
      console.log('sync exactly as observed. It now only polyfills when no native');
      console.log('WebSocket exists -- make sure you are on the updated providers.ts.');
    } else if (gqlWs && !gqlNative) {
      console.log('');
      console.log('The ws package works and native does not. Force the polyfill by');
      console.log('setting MN_FORCE_WS_POLYFILL=1 so providers.ts overrides native.');
    }
  }
  console.log('');
  console.log('Reminder: the SDK sets shouldRetry:false, so one failed connect at');
  console.log('startup is permanent. A wallet stuck at connected=false will never');
  console.log('recover on its own -- restart the process after fixing connectivity.');
}

main().catch((e) => { console.error(e); process.exit(1); });