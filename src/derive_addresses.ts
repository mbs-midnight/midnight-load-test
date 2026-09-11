/**
 * derive_addresses.ts — turn wallets.json (seeds) into fundable ADDRESSES.
 *
 * gen_wallets.py can only make seeds; addresses require the SDK's key derivation,
 * so this is the TypeScript half of fleet setup.
 *
 * For each wallet it derives and prints:
 *   unshielded address  <- FUND NIGHT HERE (NIGHT is an unshielded token)
 *   shielded address    <- for shielded transfers, not needed for funding
 *   dust address        <- identifies the DUST account
 *
 * Outputs:
 *   wallets_addresses.json  full detail per wallet (NO seeds)
 *   fund_list.txt           one unshielded address per line, for bulk faucet work
 *   fleet.csv               label,unshielded_address,dust_address  (monitor roster)
 *
 * Seeds are never written to any output file or printed.
 *
 *   npx tsx src/derive_addresses.ts --wallets wallets.json --out-dir .
 *   npx tsx src/derive_addresses.ts --seed <hex-or-mnemonic>        # single, ad hoc
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  HDWallet,
  Roles,
  createKeystore,
  PublicKey,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  DustAddress,
  MidnightBech32m,
} from '@midnight-ntwrk/wallet-sdk';
import { deriveKeysFromSeed, NETWORK_ID } from './providers.js';

interface WalletSpec {
  label: string;
  seed: string;
}

interface DerivedAddresses {
  label: string;
  unshieldedAddress: string;
  unshieldedAddressHex: string;
  shieldedAddress: string | null;
  dustAddress: string | null;
  coinPublicKey: string;
  note?: string;
}

function parseArgs() {
  const a: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  return a;
}

export function deriveAddresses(label: string, seed: string): DerivedAddresses {
  const keys = deriveKeysFromSeed(seed);

  // --- unshielded: this is the address you fund with NIGHT -----------------
  const keystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);
  const pk = PublicKey.fromKeyStore(keystore);

  // --- shielded ------------------------------------------------------------
  const zswapKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  let shieldedAddress: string | null = null;
  const notes: string[] = [];
  try {
    const coinPk = ShieldedCoinPublicKey.fromHexString(String(zswapKeys.coinPublicKey));
    const encPk = ShieldedEncryptionPublicKey.fromHexString(String(zswapKeys.encryptionPublicKey));
    shieldedAddress = MidnightBech32m.encode(
      NETWORK_ID as any,
      new ShieldedAddress(coinPk, encPk),
    ).asString();
  } catch (e: any) {
    notes.push(`shielded address encode failed: ${e.message?.slice(0, 80)}`);
  }

  // --- dust ----------------------------------------------------------------
  const dustKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  let dustAddress: string | null = null;
  try {
    dustAddress = DustAddress.encodePublicKey(NETWORK_ID, dustKey.publicKey);
  } catch (e: any) {
    notes.push(`dust address encode failed: ${e.message?.slice(0, 80)}`);
  }

  return {
    label,
    unshieldedAddress: pk.address,
    unshieldedAddressHex: String(pk.addressHex),
    shieldedAddress,
    dustAddress,
    coinPublicKey: String(zswapKeys.coinPublicKey),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

function main() {
  const args = parseArgs();

  let wallets: WalletSpec[];
  if (args.seed) {
    wallets = [{ label: args.label ?? 'adhoc', seed: args.seed }];
  } else {
    const path = args.wallets ?? 'wallets.json';
    wallets = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(wallets) || !wallets.length) {
      throw new Error(`${path} is empty or not an array`);
    }
  }

  const outDir = args['out-dir'] ?? '.';
  const derived: DerivedAddresses[] = [];
  const failures: { label: string; error: string }[] = [];

  for (const w of wallets) {
    try {
      derived.push(deriveAddresses(w.label, w.seed));
    } catch (e: any) {
      failures.push({ label: w.label, error: e.message?.slice(0, 200) ?? String(e) });
    }
  }

  console.log(`network: ${NETWORK_ID}\n`);
  console.log('FUND THE UNSHIELDED ADDRESS with tNIGHT, then delegate to start DUST generation.\n');
  for (const d of derived) {
    console.log(`${d.label}`);
    console.log(`  unshielded (FUND THIS): ${d.unshieldedAddress}`);
    console.log(`  shielded:               ${d.shieldedAddress ?? '(unavailable)'}`);
    console.log(`  dust:                   ${d.dustAddress ?? '(unavailable)'}`);
    if (d.note) console.log(`  note: ${d.note}`);
    console.log('');
  }
  if (failures.length) {
    console.error(`${failures.length} wallet(s) failed derivation:`);
    for (const f of failures) console.error(`  ${f.label}: ${f.error}`);
  }

  // Never write seeds to these files.
  writeFileSync(`${outDir}/wallets_addresses.json`, JSON.stringify(derived, null, 2));
  writeFileSync(
    `${outDir}/fund_list.txt`,
    derived.map((d) => d.unshieldedAddress).join('\n') + '\n',
  );
  // Roster for dust_budget_monitor.py. NOTE: that tool queries the indexer's
  // dustGenerationStatus, which is keyed by CARDANO REWARD ADDRESS and therefore
  // only sees registered cNIGHT -- it will NOT see native Midnight NIGHT funded
  // straight from the preprod faucet. See the caveat printed below.
  const csv = ['label,unshielded_address,dust_address']
    .concat(derived.map((d) => `${d.label},${d.unshieldedAddress},${d.dustAddress ?? ''}`))
    .join('\n');
  writeFileSync(`${outDir}/fleet.csv`, csv + '\n');

  console.log(`wrote:\n  ${outDir}/wallets_addresses.json  (no seeds)`);
  console.log(`  ${outDir}/fund_list.txt            (${derived.length} addresses, one per line)`);
  console.log(`  ${outDir}/fleet.csv`);
  console.log(`
CAVEAT on monitoring: dust_budget_monitor.py queries the indexer's
dustGenerationStatus, which is keyed by CARDANO reward address and only sees
registered cNIGHT. Wallets funded with native tNIGHT from the preprod faucet
will NOT appear there. For those, read DUST from the wallet itself --
facade.state() exposes the dust section per wallet. Confirm which funding path
your NIGHT actually takes before relying on the monitor.`);
}

// Only run when executed directly. Without this guard, importing deriveAddresses
// (as preflight.ts and wallet_status.ts do) executed main() as a side effect --
// dumping every wallet's addresses to the console and REWRITING fund_list.txt,
// fleet.csv and wallets_addresses.json on every import.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? '';
  return /derive_addresses(\.[tj]s)?$/.test(entry);
})();

if (invokedDirectly) {
  main();
}