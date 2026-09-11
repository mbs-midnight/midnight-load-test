/**
 * test_address.ts — ask the indexer directly whether it has ANY transactions for
 * an unshielded address. Bypasses the wallet SDK entirely.
 *
 * WHY THIS EXISTS
 * ---------------
 * A wallet reporting `appliedIndex 0 / highestRelevantWalletIndex 0` with
 * isConnected=true is not "stuck" -- per the SDK's own definition it is SYNCED:
 *
 *     isStrictlyComplete() = isConnected && |highestRelevantWalletIndex - appliedIndex| === 0
 *
 * So 0/0 + connected means "fully caught up, and the indexer reports zero
 * transactions for this address". If you funded that address and the explorer
 * showed success, exactly one of these is true:
 *
 *   a) the funded address differs from the derived address (seed/roster drift),
 *   b) the indexer has not associated the transaction with this address,
 *   c) the wallet subscribed with a differently-encoded form of the address.
 *
 * This script settles it. It subscribes to the same feed the wallet uses --
 *     subscription { unshieldedTransactions(address: "<bech32>") { ... } }
 * -- and prints highestTransactionId plus any UTXOs. The address must be
 * Bech32m ("mn_addr_preprod1..."); the schema documents owner as
 * "Owner Bech32m-encoded address".
 *
 *   npx tsx src/test_address.ts --address mn_addr_preprod1...
 *   npx tsx src/test_address.ts --wallets wallets.json --only w000
 *   npx tsx src/test_address.ts --seed "$MIDNIGHT_PREPROD_SEED"
 */

import { readFileSync } from 'node:fs';
import { createClient } from 'graphql-ws';
import { deriveAddresses } from './derive_addresses.js';

const argv = process.argv.slice(2);
const argOf = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// From providers.ts so MN_NETWORK is honoured -- testing preview must hit preview.
import { INDEXER_WS as WS_URL, INDEXER_HTTP as HTTP_URL, NETWORK_ID } from './providers.js';
const WAIT_MS = Number(argOf('wait-ms') ?? 30_000);

const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m   ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m!!\x1b[0m   ${m}`);
const info = (m: string) => console.log(`       ${m}`);

// The SDK subscribes with `transactionId: Number(appliedId)` -- i.e. 0 on a cold
// start (wallet-sdk-unshielded-wallet/dist/v1/Sync.js:39). This test originally
// omitted the argument entirely and DID receive data, so the two forms are worth
// comparing directly: pass --transaction-id 0 to reproduce exactly what the SDK
// sends. If omitting it works and 0 does not, that difference is the bug.
const QUERY = `
subscription WatchAddress($address: UnshieldedAddress!, $transactionId: Int) {
  unshieldedTransactions(address: $address, transactionId: $transactionId) {
    __typename
    ... on UnshieldedTransactionsProgress {
      highestTransactionId
    }
    ... on UnshieldedTransaction {
      transaction {
        __typename
        ... on RegularTransaction {
          hash
          fee
          transactionResult { status }
        }
      }
      createdUtxos {
        owner
        tokenType
        value
        intentHash
        outputIndex
        ctime
        registeredForDustGeneration
      }
      spentUtxos { owner tokenType value }
    }
  }
}`;

async function tipHeight(): Promise<number | null> {
  try {
    const res = await fetch(HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
    });
    const doc: any = await res.json();
    return doc?.data?.block?.height ?? null;
  } catch {
    return null;
  }
}

function watch(address: string, transactionId?: number): Promise<{
  progress: number | null;
  txCount: number;
  utxos: any[];
  errors: string[];
}> {
  return new Promise((resolve) => {
    const client = createClient({ url: WS_URL, shouldRetry: () => false, keepAlive: 15_000 });
    let progress: number | null = null;
    let txCount = 0;
    const utxos: any[] = [];
    const errors: string[] = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { client.dispose(); } catch { /* ignore */ }
      resolve({ progress, txCount, utxos, errors });
    };
    const timer = setTimeout(finish, WAIT_MS);

    const dispose = client.subscribe(
      {
        query: QUERY,
        variables: {
          address,
          ...(transactionId !== undefined ? { transactionId } : {}),
        },
      },
      {
        next: (msg: any) => {
          const ev = msg?.data?.unshieldedTransactions;
          if (!ev) return;
          if (ev.__typename === 'UnshieldedTransactionsProgress') {
            progress = ev.highestTransactionId;
            info(`progress event: highestTransactionId = ${progress}`);
          } else if (ev.__typename === 'UnshieldedTransaction') {
            txCount++;
            const created = ev.createdUtxos ?? [];
            const st = ev.transaction?.transactionResult?.status ?? '?';
            info(
              `tx ${String(ev.transaction?.hash ?? '?').slice(0, 20)}... status=${st} ` +
                `created=${created.length} spent=${(ev.spentUtxos ?? []).length}`,
            );
            for (const u of created) utxos.push(u);
          }
        },
        error: (err: any) => {
          const m = JSON.stringify(err).slice(0, 300);
          errors.push(m);
          bad(`subscription error: ${m}`);
          clearTimeout(timer);
          finish();
        },
        complete: () => {
          clearTimeout(timer);
          finish();
        },
      },
    );
    void dispose;
  });
}

async function main() {
  let addresses: { label: string; address: string }[] = [];

  const explicit = argOf('address');
  if (explicit) {
    addresses = [{ label: 'explicit', address: explicit }];
  } else if (argOf('wallets')) {
    let ws: { label: string; seed: string }[] = JSON.parse(readFileSync(argOf('wallets')!, 'utf8'));
    const only = argOf('only');
    if (only) ws = ws.filter((w) => w.label === only);
    addresses = ws.map((w) => {
      const d = deriveAddresses(w.label, w.seed);
      return { label: w.label, address: d.unshieldedAddress };
    });
  } else {
    const seed = argOf('seed') ?? process.env.MIDNIGHT_PREPROD_SEED ?? process.env.MIDNIGHT_PREPROD_MNEMONIC;
    if (!seed) throw new Error('pass --address, --wallets, or --seed');
    const d = deriveAddresses('wallet', seed);
    addresses = [{ label: 'wallet', address: d.unshieldedAddress }];
  }

  const tip = await tipHeight();
  console.log(`network: ${NETWORK_ID}`);
  console.log(`indexer: ${WS_URL}`);
  console.log(`tip height: ${tip ?? '(unavailable)'}`);
  console.log(`watching ${addresses.length} address(es) for up to ${WAIT_MS / 1000}s each\n`);

  for (const { label, address } of addresses) {
    console.log(`--- ${label} ---`);
    console.log(`  ${address}`);
    const txIdArg = argOf('transaction-id');
    const txId = txIdArg !== undefined ? Number(txIdArg) : undefined;
    if (txId !== undefined) info(`passing transactionId: ${txId} (as the SDK does)`);
    else info('omitting transactionId (SDK passes 0 -- compare with --transaction-id 0)');
    const r = await watch(address, txId);

    if (r.errors.length) {
      bad('the indexer rejected the subscription. If it complains about the address');
      bad('format, the wallet is likely subscribing with a different encoding than');
      bad('the one derived here -- that mismatch would itself explain a 0/0 sync.');
      continue;
    }

    if (r.progress === null && r.txCount === 0) {
      bad('no progress event and no transactions within the wait window.');
      info('The subscription connected but the indexer said nothing at all. Either the');
      info('address has never been seen, or the feed is not emitting. Try a longer');
      info('--wait-ms before concluding.');
    } else if ((r.progress ?? 0) === 0 && r.txCount === 0) {
      bad(`highestTransactionId = 0: the indexer has NO transactions for this address.`);
      info('');
      info('This is authoritative and independent of the wallet SDK. Your wallet is');
      info('therefore correctly synced-and-empty, not stuck. Check, in order:');
      info('  1. Does the address you funded match the one printed above, character');
      info('     for character? Compare against the explorer.');
      info('  2. Has wallets.json been regenerated since you funded? gen_wallets.py');
      info('     makes fresh random seeds, which changes every address.');
      info('  3. Did the funding tx target a different network (preview vs preprod)?');
    } else {
      ok(`highestTransactionId = ${r.progress}, saw ${r.txCount} transaction(s)`);
      if (r.utxos.length) {
        console.log(`  UTXOs created for this address: ${r.utxos.length}`);
        for (const u of r.utxos) {
          console.log(
            `    value=${u.value} token=${String(u.tokenType).slice(0, 16)}... ` +
              `#${u.outputIndex} registeredForDust=${u.registeredForDustGeneration}`,
          );
        }
        ok('The indexer DOES see funds here. If the wallet still shows nothing, the');
        info('problem is in the wallet layer, not the chain or the funding.');
      } else {
        info('Transactions exist but created no UTXOs owned by this address -- it may');
        info('have been the SENDER rather than the recipient.');
      }
    }
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });