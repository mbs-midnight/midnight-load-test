/**
 * preflight.ts — prove every external dependency works BEFORE spending NIGHT.
 *
 * Runs a sequence of cheap checks and stops at the first hard failure. Nothing
 * here submits a transaction or costs DUST. Run it until everything is green.
 *
 *   ARKHIA_API_KEY=... MN_PROOF_SERVER=https://starter.arkhia.io/midnight/zkpaas/preprod/ \
 *     npm run preflight
 *
 * The most valuable thing it does is settle the Arkhia auth question by probing
 * the proof server three ways (bare, x-api-key header, key-in-query) and telling
 * you which one the endpoint accepts.
 */

import {
  PROOF_SERVER_URL,
  INDEXER_HTTP,
  ARKHIA_API_KEY,
  ARKHIA_API_SECRET,
  NETWORK_ID,
} from './providers.js';

// A local proof server (127.0.0.1 / localhost, any port) needs NO auth and no
// Arkhia keys. Everything Arkhia-specific below is gated on this so the output
// is clean when running locally -- which is the norm for preview/qanet.
const IS_LOCAL_PROOF_SERVER = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(
  PROOF_SERVER_URL,
);
import { deriveAddresses } from './derive_addresses.js';

const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m   ${m}`);
const bad = (m: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
const info = (m: string) => console.log(`       ${m}`);

let hardFail = false;

async function timedFetch(url: string, init: RequestInit = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const started = Date.now();
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
async function checkEnv() {
  console.log('\n[1] environment');
  if (IS_LOCAL_PROOF_SERVER) {
    ok('local proof server -- no Arkhia keys needed');
    if (ARKHIA_API_KEY || ARKHIA_API_SECRET) {
      info('(ARKHIA_API_KEY/SECRET are set but ignored for a local proof server;');
      info(' you can unset them to keep the environment clean.)');
    }
  } else {
    // Hosted (e.g. Arkhia) path: keys matter.
    if (!ARKHIA_API_KEY) {
      bad('ARKHIA_API_KEY is empty and the proof server is not local. Export it, or');
      bad('point MN_PROOF_SERVER at a local server (http://127.0.0.1:6300/).');
      hardFail = true;
    } else {
      ok(`ARKHIA_API_KEY present (${ARKHIA_API_KEY.length} chars)`);
    }
    if (!ARKHIA_API_SECRET) {
      info('ARKHIA_API_SECRET not set. A hosted Arkhia project may require BOTH');
      info('x-api-key and x-api-secret -- if [2] returns 401 for every mode, set it.');
    } else {
      ok(`ARKHIA_API_SECRET present (${ARKHIA_API_SECRET.length} chars)`);
    }
  }
  const seed = process.env.MIDNIGHT_PREPROD_SEED;
  const mnem = process.env.MIDNIGHT_PREPROD_MNEMONIC;
  if (!seed && !mnem) {
    bad('neither MIDNIGHT_PREPROD_SEED nor MIDNIGHT_PREPROD_MNEMONIC is set');
    hardFail = true;
  } else if (seed && mnem) {
    bad('both SEED and MNEMONIC set -- define exactly one');
    hardFail = true;
  } else {
    ok(`wallet secret present (${seed ? 'seed' : 'mnemonic'})`);
  }
  info(`network: ${NETWORK_ID}`);
  info(`proof server: ${PROOF_SERVER_URL}`);
  info(`indexer: ${INDEXER_HTTP}`);
}

// ---------------------------------------------------------------------------
// Probe the proof server's auth expectation. We don't know Arkhia's exact
// health path, so try a few common ones; any non-network response tells us the
// host is reachable, and the status code distribution across auth modes tells us
// which auth the endpoint wants.
async function checkProofServer() {
  console.log('\n[2] proof server reachability');
  const base = PROOF_SERVER_URL.replace(/\/$/, '');
  const paths = ['/health', '/', '/version', '/ready'];

  // Local proof server: no auth, no Arkhia probing. Just confirm it answers.
  if (IS_LOCAL_PROOF_SERVER) {
    for (const pth of paths) {
      try {
        const { res, ms } = await timedFetch(base + pth, { method: 'GET' });
        // Any HTTP response (even 404) means the container is up and listening.
        ok(`local proof server responding at ${pth} (HTTP ${res.status}, ${ms}ms)`);
        return;
      } catch {
        /* try next path */
      }
    }
    bad('local proof server not responding on any path.');
    info(`Tried ${base}. Is the docker container running and mapped to this port?`);
    info('  docker run -p 6300:6300 -v $(pwd)/.cache/midnight/zk-params:/.cache/midnight/zk-params \\');
    info('    midnightnetwork/proof-server:4.0.0');
    info('Note: 6301 is the OLD proxy port; the proof server listens on 6300.');
    hardFail = true;
    return;
  }


  // Arkhia's documented scheme is x-api-key PLUS x-api-secret together when the
  // secret is activated. It also supports embedding the key in the URL path with
  // only the secret in a header (e.g. /json-rpc/v1/<KEY>). Probe both families --
  // sending a single header alone, which an earlier version of this script did,
  // fails with 401 on every attempt and tells you nothing.
  const keyed = `${base}/${ARKHIA_API_KEY}`;
  const modes: { name: string; headers?: Record<string, string>; bases?: string[] }[] = [
    {
      name: 'x-api-key + x-api-secret (Arkhia documented)',
      headers: {
        'x-api-key': ARKHIA_API_KEY,
        ...(ARKHIA_API_SECRET ? { 'x-api-secret': ARKHIA_API_SECRET } : {}),
      },
    },
    { name: 'x-api-key only', headers: { 'x-api-key': ARKHIA_API_KEY } },
    {
      name: 'key in path + x-api-secret',
      headers: ARKHIA_API_SECRET ? { 'x-api-secret': ARKHIA_API_SECRET } : {},
      bases: [keyed],
    },
    { name: 'key in path only', bases: [keyed] },
    { name: 'bare (no auth)', headers: {} },
  ];

  let reachable = false;
  const accepted: { mode: string; url: string; status: number }[] = [];

  for (const mode of modes) {
    let done = false;
    for (const b of mode.bases ?? [base]) {
      for (const p of paths) {
        const url = b + p;
        try {
          const { res, ms } = await timedFetch(url, { method: 'GET', headers: mode.headers });
          reachable = true;
          if (res.status < 400) {
            accepted.push({ mode: mode.name, url, status: res.status });
            ok(`${mode.name}: ${res.status} at ${p} (${ms}ms)`);
            done = true;
            break;
          }
          if (res.status === 401 || res.status === 403) {
            info(`${mode.name}: ${res.status} at ${p} (rejected)`);
            done = true;
            break;
          }
          if (res.status === 404) continue; // wrong path, keep trying
          info(`${mode.name}: ${res.status} at ${p}`);
          done = true;
          break;
        } catch {
          /* network-level, try next */
        }
      }
      if (done) break;
    }
  }

  if (!reachable) {
    bad('proof server unreachable on all probes.');
    info(`Tried: ${PROOF_SERVER_URL}. For a LOCAL server it should be `);
    info('http://127.0.0.1:6300/ (default port 6300) and the docker container must be');
    info('running. For a hosted server, check the URL and network egress. NOTE: port');
    info('6301 is the old proxy.mjs port -- the proof server itself listens on 6300.');
    hardFail = true;
    return;
  }
  if (accepted.length === 0) {
    bad('proof server reachable but every auth mode was rejected.');
    if (!ARKHIA_API_SECRET) {
      info('ARKHIA_API_SECRET is NOT SET and Arkhia requires x-api-key + x-api-secret');
      info('together when the secret is activated. Set it and re-run -- this is the');
      info('single most likely cause.');
    } else {
      info('Both key and secret were sent. Check that ZKPaas is enabled for this');
      info('project and that the key/secret pair matches the same project.');
    }
    info('Note: /health may simply not be a route Arkhia exposes. A 401 on every path');
    info('means the gateway rejected you before routing, so auth is still the issue.');
    hardFail = true;
    return;
  }

  const winner = accepted[0];
  ok(`working auth mode: ${winner.mode}`);
  if (winner.mode.startsWith('key in path')) {
    // Do NOT print the keyed URL. With path-based auth the key IS the credential,
    // and console output ends up in terminal scrollback, CI logs and pasted
    // bug reports. Print the shape and let the shell substitute the value.
    const shape = winner.url
      .replace(/\/(health|version|ready)$/, '')
      .replace(ARKHIA_API_KEY, '${ARKHIA_API_KEY}');
    info('Set your proof server URL to (shell will substitute the key):');
    info(`  MN_PROOF_SERVER="${shape}/"`);
    if (accepted.some((a) => a.mode === 'key in path only')) {
      info('');
      info('SECURITY: "key in path only" also returned 2xx, so the key ALONE grants');
      info('access -- your API secret is not being enforced on this endpoint. The key');
      info('travels in the URL path, where it lands in proxy and server logs. Treat it');
      info('as a live credential, avoid pasting it anywhere, and ask Arkhia whether the');
      info('secret can be enforced for ZKPaas.');
    }
  }
  if (winner.mode.includes('x-api-secret') && !winner.mode.startsWith('key in path')) {
    info('This needs BOTH headers on every request. httpClientProofProvider may not');
    info('attach headers, so run the bundled proxy in another terminal:');
    info('  ARKHIA_API_KEY=... ARKHIA_API_SECRET=... node proxy.mjs');
    info('then set MN_PROOF_SERVER=http://127.0.0.1:6301/');
  }
}

// ---------------------------------------------------------------------------
async function checkIndexer() {
  console.log('\n[3] indexer (public Preprod GraphQL)');
  try {
    const { res } = await timedFetch(INDEXER_HTTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
    });
    const doc = await res.json();
    const h = doc?.data?.block?.height;
    if (h != null) {
      ok(`indexer tip height ${h}`);
    } else {
      bad(`indexer responded but no tip height: ${JSON.stringify(doc).slice(0, 160)}`);
      hardFail = true;
    }
  } catch (e: any) {
    bad(`indexer unreachable: ${e.message}`);
    hardFail = true;
  }
}

// ---------------------------------------------------------------------------
async function checkWallet() {
  console.log('\n[4] wallet + funds');
  const secret = process.env.MIDNIGHT_PREPROD_SEED ?? process.env.MIDNIGHT_PREPROD_MNEMONIC;
  if (!secret) return; // already reported in [1]

  // Derive the address WITHOUT starting the wallet -- pure key math, no network.
  // buildWallet() returns a keystore rather than an address string, so printing
  // bundle.address gave `undefined`; derive it properly instead.
  let addr: string;
  try {
    const d = deriveAddresses('preflight', secret);
    addr = d.unshieldedAddress;
    ok(`unshielded address (FUND THIS): ${addr}`);
    info(`dust address: ${d.dustAddress ?? '(unavailable)'}`);
  } catch (e: any) {
    bad(`address derivation failed: ${e.message}`);
    hardFail = true;
    return;
  }

  // Now start the wallet and read actual balances, with a timeout -- an unfunded
  // wallet on a busy indexer can take a while to reach a synced state, and we do
  // not want preflight to hang.
  const { buildWallet } = await import('./providers.js');
  let bundle;
  try {
    bundle = await buildWallet(secret);
    ok('wallet facade initialised');
  } catch (e: any) {
    bad(`buildWallet() failed: ${e.message?.slice(0, 200)}`);
    hardFail = true;
    return;
  }

  const SYNC_TIMEOUT_MS = Number(process.env.MN_SYNC_TIMEOUT_MS ?? 180_000);
  info(`waiting up to ${SYNC_TIMEOUT_MS / 1000}s for wallet sync (progress below)...`);

  // Watch actual progress rather than waiting blind. SyncProgress exposes
  // appliedIndex / highestIndex per sub-wallet, so a timeout becomes a
  // measurement ("42% in 90s") instead of an unexplained failure -- which
  // matters a lot when deciding whether a 25-wallet fleet can sync at all.
  const t0 = Date.now();
  let lastLine = '';
  const sub = bundle.wallet.state().subscribe((st: any) => {
    const fmt = (label: string, sec: any) => {
      const pr = sec?.progress;
      if (!pr) return `${label}=?`;
      const applied = Number(pr.appliedIndex ?? 0);
      const highest = Number(pr.highestIndex ?? 0);
      const pct = highest > 0 ? ((applied / highest) * 100).toFixed(1) : '?';
      return `${label}=${applied}/${highest} (${pct}%)`;
    };
    const line =
      `       ${fmt('shielded', st?.shielded)}  ${fmt('dust', st?.dust)}` +
      `  synced=${st?.isSynced ?? '?'}`;
    if (line !== lastLine) {
      lastLine = line;
      console.log(line);
    }
  });

  const synced = await Promise.race([
    bundle.wallet.waitForSyncedState().then((st: any) => ({ ok: true as const, st })),
    new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), SYNC_TIMEOUT_MS)),
  ]);
  try { sub.unsubscribe?.(); } catch { /* ignore */ }

  if (!synced.ok) {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    info(`sync did not finish within ${secs}s.`);
    info('If the numerators above were CLIMBING (e.g. dust 2568 -> 2581), sync is');
    info('working and just needs more time -- raise MN_SYNC_TIMEOUT_MS. A 0 denominator');
    info('is normal for a fresh wallet mid-sync; it is not the failure.');
    info('Read the progress lines above: if appliedIndex is CLIMBING, sync works and');
    info('just needs longer -- raise MN_SYNC_TIMEOUT_MS and extrapolate how long one');
    info('wallet takes, because your whole fleet pays that cost at startup. If it is');
    info('STUCK at 0 or isConnected=false, that is a connectivity problem, not patience.');
    return;
  }

  try {
    const st: any = synced.st;
    const SPECKS_PER_DUST = 1_000_000_000_000_000n;
    const STARS_PER_NIGHT = 1_000_000n;
    const fmt = (raw: bigint, per: bigint, dp: number) => {
      const frac = raw % per;
      return `${raw / per}.${frac.toString().padStart(per.toString().length - 1, '0').slice(0, dp)}`;
    };

    // Real accessors, not a JSON dump:
    //   unshielded.balances      Record<RawTokenType, bigint>   (NIGHT, in STAR)
    //   dust.balance(date)       bigint                         (SPECK)
    //   unshielded.availableCoins[].meta.registeredForDustGeneration
    const balances: Record<string, bigint> = st?.unshielded?.balances ?? {};
    const entries = Object.entries(balances);
    if (entries.length === 0) {
      info('NIGHT: none seen yet');
    } else {
      for (const [tokenType, raw] of entries) {
        info(`NIGHT: ${fmt(raw as bigint, STARS_PER_NIGHT, 6)} (${raw} STAR, token ${tokenType.slice(0, 16)}...)`);
      }
    }

    let dustSpeck = 0n;
    try { dustSpeck = st?.dust?.balance ? st.dust.balance(new Date()) : 0n; } catch { /* pre-sync */ }
    info(`DUST:  ${fmt(dustSpeck, SPECKS_PER_DUST, 15)} (${dustSpeck} SPECK)`);

    const coins: readonly any[] = st?.unshielded?.availableCoins ?? [];
    const unregistered = coins.filter((c) => !c.meta?.registeredForDustGeneration).length;
    info(`UTXOs: ${coins.length} total, ${unregistered} NOT registered for DUST generation`);

    const hasNight = entries.some(([, v]) => (v as bigint) > 0n);
    if (!hasNight) {
      info('');
      info('No NIGHT yet. Fund the unshielded address above.');
    } else if (dustSpeck === 0n && unregistered > 0) {
      info('');
      info('NIGHT is present but UNREGISTERED, so it generates no DUST and this wallet');
      info('cannot pay a fee. Register it:');
      info('  npx tsx src/wallet_status.ts --seed "$MIDNIGHT_PREPROD_SEED" --delegate');
    } else if (dustSpeck === 0n) {
      info('');
      info('NIGHT registered but DUST still 0 -- generation accrues over time. Re-check soon.');
    } else {
      ok('wallet has both NIGHT and DUST: ready to deploy');
    }
  } catch (e: any) {
    info(`could not summarise balances: ${e.message?.slice(0, 120)}`);
  }
}

async function main() {
  console.log('DUST sweep harness — preflight');
  await checkEnv();
  await checkProofServer();
  await checkIndexer();
  await checkWallet();
  console.log('');
  if (hardFail) {
    console.log('\x1b[31mpreflight FAILED — fix the above before deploying.\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mpreflight passed the reachable checks. Confirm wallet funds, then deploy.\x1b[0m');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});