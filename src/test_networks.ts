/**
 * test_networks.ts — compare the remote networks so you can pick the one with the
 * least history for the dust-wallet sync.
 *
 * The dust wallet's memory grows with chain history, so the whole point of moving
 * off preprod is to land on a younger chain. This prints each network's current
 * tip height and whether its indexer/faucet respond, side by side, WITHOUT
 * building a wallet -- pure HTTP, seconds to run.
 *
 *   npx tsx src/test_networks.ts
 *
 * A lower tip is better here. But note: "younger" is not guaranteed -- preview may
 * well be millions of blocks deep too, in which case a remote switch does not
 * solve the dust OOM and a local/low-history devnet is the remaining option.
 */

const NETS = ['preprod', 'preview', 'qanet'] as const;
const HOST: Record<string, string> = {
  preprod: 'indexer.preprod.midnight.network',
  preview: 'indexer.preview.midnight.network',
  qanet: 'indexer.qanet.dev.midnight.network',
};
const FAUCET: Record<string, string> = {
  preprod: 'https://faucet.preprod.midnight.network/api/request-tokens',
  preview: 'https://faucet.preview.midnight.network/api/request-tokens',
  qanet: 'https://faucet.qanet.dev.midnight.network/api/request-tokens',
};

async function tip(host: string): Promise<{ height: number | null; ms: number; err?: string }> {
  const url = `https://${host}/api/v4/graphql`;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const doc: any = await res.json();
    return { height: doc?.data?.block?.height ?? null, ms: Date.now() - t0 };
  } catch (e: any) {
    return { height: null, ms: Date.now() - t0, err: e.message?.slice(0, 60) };
  }
}

async function faucetUp(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    // GET a POST-only endpoint: any HTTP status (even 404/405) means it is up.
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(timer);
    return res.status > 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log('network comparison (lower tip = less history = friendlier to dust sync)\n');
  console.log('  network   tip height     indexer     faucet');
  console.log('  -------   -----------     -------     ------');

  const rows: { net: string; height: number | null }[] = [];
  for (const net of NETS) {
    const t = await tip(HOST[net]);
    const f = await faucetUp(FAUCET[net]);
    rows.push({ net, height: t.height });
    const h = t.height != null ? t.height.toLocaleString() : `(${t.err ?? 'no data'})`;
    console.log(
      `  ${net.padEnd(9)} ${h.padStart(11)}     ` +
        `${(t.height != null ? 'up' : 'down').padEnd(8)}    ${f ? 'up' : 'down'}`,
    );
  }

  const reachable = rows.filter((r) => r.height != null) as { net: string; height: number }[];
  if (reachable.length > 1) {
    reachable.sort((a, b) => a.height - b.height);
    const lowest = reachable[0];
    console.log(`\nleast history: ${lowest.net} at ${lowest.height.toLocaleString()} blocks`);
    const preprod = reachable.find((r) => r.net === 'preprod');
    if (preprod && lowest.net !== 'preprod') {
      const ratio = (preprod.height / lowest.height).toFixed(1);
      console.log(
        `${lowest.net} has ${ratio}x less history than preprod -- dust sync memory scales with`,
      );
      console.log('history, so that is roughly the memory-pressure reduction to expect.');
    }
    console.log(`\nTo use it:  export MN_NETWORK=${lowest.net}`);
    console.log('Then set MN_PROOF_SERVER for that network and re-derive addresses');
    console.log('(addresses are network-scoped: mn_addr_<network>1...), fund, and delegate.');
  }
  console.log('\nReminder: switching networks changes the address prefix, so you must');
  console.log('re-run `npm run addresses`, re-fund, and re-delegate on the new network.');
}

main().catch((e) => { console.error(e); process.exit(1); });