/**
 * mint.ts -- deploy a shielded-token contract on Stagenet and mint a shielded
 * coin to this wallet.
 *
 * WHY THIS EXISTS. The shielded transfer test needs shielded balance, and there
 * is no way to get any:
 *   - the Stagenet faucet only drips unshielded NIGHT, behind a captcha;
 *   - initSwap (unshielded -> shielded) is rejected by the node with ledger
 *     error 231, reproducibly.
 * So we mint our own. The contract is midnight-js's OWN e2e fixture
 * (testkit-js-e2e/src/contract/shielded.compact), which is the authoritative
 * example of `kernel.mintShielded` + `sendShielded`, and its
 * `mintAndSendShielded` circuit sends the minted coin straight to a
 * ZswapCoinPublicKey -- ours.
 *
 * VERSION SET (deviates from the partner doc's matrix, deliberately):
 *   compactc 0.34.0        -> Compact runtime 0.19.0
 *   midnight-js 5.0.0-beta.7 -> compact-runtime 0.19.0-rc.0, ledger-v9 1.0.0-rc.3
 *   wallet-sdk 2.0.0-beta.2  -> ledger-v9 1.0.0-rc.3
 * The doc pairs compactc 0.33.0-rc.2 with runtime 0.18.0-rc.1, but 0.33 was
 * never published to the compact release channel -- `compact update 0.33` fails
 * with "No version matching 0.33 found". 0.34.0 is the lowest installable
 * toolchain, and midnight-js beta.7 is the line whose runtime pin matches it.
 * Critically, all three agree on ledger-v9 1.0.0-rc.3, so there is only ever ONE
 * copy of the ledger WASM -- the thing that breaks provider wiring when it drifts.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import * as CompiledShielded from '../contract/src/managed/shielded/contract/index.js';

import {
  buildWallet, waitForRealSync, firstState, describeError,
  NETWORK_ID, INDEXER_HTTP, INDEXER_WS, PROOF_SERVER,
} from './wallet.js';

const args = process.argv.slice(2);
const argOf = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const LOG = argOf('log', 'mint.jsonl')!;
const log = (rec: any) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...rec });
  appendFileSync(LOG, line + '\n');
  console.log(line);
};

setNetworkId(NETWORK_ID as any);

const CompiledShieldedContract = CompiledContract.make<CompiledShielded.Contract<undefined>>(
  'Shielded',
  CompiledShielded.Contract as any,
).pipe(
  // The contract declares no witnesses, so the witness slot is filled vacantly
  // rather than with an object -- withWitnesses({}) does not type-check here.
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(
    path.resolve(process.cwd(), 'contract/src/managed/shielded'),
  ),
) as any;

async function main() {
  const seed = process.env.MN_STAGENET_SEED;
  if (!seed) throw new Error('MN_STAGENET_SEED is not set');

  const b = await buildWallet(seed);
  await waitForRealSync(b.wallet, { label: 'mint', requireDustCoins: true });
  const st = await firstState(b.wallet);
  log({ event: 'synced', dustCoins: (st?.dust?.availableCoins ?? []).length,
        shieldedCoins: (st?.shielded?.availableCoins ?? []).length });

  /**
   * midnight-js needs a WalletProvider (balance + keys) and a MidnightProvider
   * (submit). Both are thin adapters over the wallet-sdk facade. balanceTx must
   * return a FINALIZED transaction, so it balances and then proves -- and note
   * it does NOT sign: a contract call's dust/zswap sections are authorised by
   * proofs, and signing here would be the double-sign that yields error 192.
   */
  const walletProvider = {
    getCoinPublicKey: () => b.zswapSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => b.zswapSecretKeys.encryptionPublicKey,
    balanceTx: async (tx: any, ttl?: Date) => {
      const recipe = await b.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 60 * 60 * 1000) },
      );
      return await b.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => b.wallet.submitTransaction(tx),
  };

  const zkConfigProvider = new NodeZkConfigProvider<any>(
    path.resolve(process.cwd(), 'contract/src/managed/shielded'),
  );

  const providers: any = {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: '.mnstate/shielded',
      privateStateStoreName: 'shielded-private-store',
      signingKeyStoreName: 'shielded-signing-keys',
      accountId: 'stagenet-smoke',
      // 5.x STRENGTHENED THIS. v4 only required >= 16 characters; beta.7 also
      // demands at least 3 of {uppercase, lowercase, digits, special} and fails
      // at deploy time with "Found: 2" otherwise. LOCAL at-rest key for
      // benchmark state, not a network secret.
      privateStoragePasswordProvider: () =>
        process.env.MN_PRIVATE_STATE_PASSWORD ?? 'Stagenet-Smoke-Local-Dev-Key-1',
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider as any),
    walletProvider,
    midnightProvider: walletProvider,
  };

  let contractAddress = argOf('at');
  if (!contractAddress) {
    log({ event: 'deploying' });
    const t0 = Date.now();
    const deployed: any = await deployContract(providers, {
      compiledContract: CompiledShieldedContract,
      signingKey: sampleSigningKey(),
      initialPrivateState: undefined,
    } as any);
    contractAddress = deployed.deployTxData.public.contractAddress;
    log({ event: 'deployed', contractAddress, ms: Date.now() - t0 });
  }

  // Send the minted coin straight to our own zswap coin public key.
  const coinPk = b.zswapSecretKeys.coinPublicKey;
  const keyBytes = typeof coinPk === 'string'
    ? Uint8Array.from(Buffer.from(coinPk.replace(/^0x/, ''), 'hex'))
    : ((coinPk as any).bytes ?? coinPk);

  const amount = BigInt(argOf('amount', '1000000')!);
  const domainSep = new Uint8Array(32).fill(1);
  const mintNonce = new Uint8Array(32).fill(42);

  log({ event: 'minting', contractAddress, amount: String(amount) });
  const t1 = Date.now();
  const txData: any = await submitCallTx(providers, {
    compiledContract: CompiledShieldedContract,
    contractAddress,
    circuitId: 'mintAndSendShielded',
    args: [domainSep, amount, mintNonce, { bytes: keyBytes }, amount],
  } as any);
  log({ event: 'minted', status: String(txData?.public?.status), ms: Date.now() - t1,
        txId: String(txData?.public?.txId ?? '') });

  await b.wallet.stop();
}

main()
  .then(() => setTimeout(() => process.exit(0), 2000).unref())
  .catch((e) => { console.error('FATAL:', describeError(e)); process.exit(1); });
