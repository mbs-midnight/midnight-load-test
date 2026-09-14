// Defect (migration note): createKeystore now takes {kind, secret} and `kind`
// is an explicit signature scheme. The wrong value derives a DIFFERENT address
// from the same secret, with no error. Offline; uses a throwaway secret.
import { randomBytes } from 'node:crypto';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk';

const secret = randomBytes(32);            // throwaway, never funded
const kinds = ['schnorr', 'ecdsa'];
const addr = {};
for (const kind of kinds) {
  const ks = createKeystore({ kind, secret }, 'stagenet');
  addr[kind] = String(ks.getBech32Address?.() ?? ks.getAddress?.() ?? ks.getPublicKey?.());
  console.log(`${kind.padEnd(8)} → ${addr[kind].slice(0, 32)}…`);
}
if (addr.schnorr !== addr.ecdsa) {
  console.log('RESULT keystore-kind: REPRODUCED — same 32-byte secret, two different addresses; no warning, no error');
  process.exit(0);
}
console.log('RESULT keystore-kind: NOT REPRODUCED — both kinds derived the same address');
process.exit(1);
