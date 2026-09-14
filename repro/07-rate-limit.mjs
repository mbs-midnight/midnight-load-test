// Defect: rate limiting on the hosted preview endpoints is undocumented and
// disproportionate (403s from ~4.6 req/s; hard IP block at ~12 req/s sustained,
// covering indexer, RPC and faucet over HTTP and WebSocket, 1–3 min to recover).
//
// THIS BLOCKS YOUR IP FOR MINUTES. Refuses to run without --confirm.
// Usage: node repro/07-rate-limit.mjs --confirm [--url <graphql>] [--rps 2,5,12] [--seconds 20]
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : []).filter((x) => x.length));
if (!args.confirm) { console.log('RESULT 07-rate-limit: SKIPPED — pass --confirm (this will rate-limit your IP)'); process.exit(2); }
const url = args.url ?? 'https://indexer.preview.midnight.network/api/v4/graphql';
const steps = String(args.rps ?? '2,5,12').split(',').map(Number);
const seconds = Number(args.seconds ?? 20);
const q = JSON.stringify({ query: '{ block { height } }' });
let firstBlock = null;
for (const rps of steps) {
  const counts = {}; const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const tick = Date.now();
    await Promise.all(Array.from({ length: rps }, async () => {
      n++;
      try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: q }); counts[r.status] = (counts[r.status] ?? 0) + 1; }
      catch (e) { counts[e.cause?.code ?? 'ERR'] = (counts[e.cause?.code ?? 'ERR'] ?? 0) + 1; }
    }));
    const wait = 1000 - (Date.now() - tick); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`offered ${rps} req/s for ${seconds}s → ${n} requests: ${JSON.stringify(counts)}`);
  if (!firstBlock && (counts[403] || counts[429])) firstBlock = rps;
}
if (firstBlock) { console.log(`RESULT 07-rate-limit: REPRODUCED — first 403/429 at ${firstBlock} req/s offered (recovery takes 1–3 min of quiet)`); process.exit(0); }
console.log('RESULT 07-rate-limit: NOT REPRODUCED — no 403/429 across steps ' + steps.join(','));
process.exit(1);
