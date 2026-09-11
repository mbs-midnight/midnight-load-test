// Emit N BIP39 mnemonics using @scure/bip39 -- the SAME audited library the
// wallet uses inside seedToBytes(). Generating with any other implementation
// risks a subtly different wordlist or checksum and therefore unfundable
// wallets, so we deliberately reuse the one already in the dependency tree.
//
//   node src/gen_mnemonics.mjs <count> [wordCount=24]
//
// Prints one mnemonic per line to stdout. 24 words = 256 bits (default),
// 12 words = 128 bits. Randomness comes from the library's CSPRNG.
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const count = Number(process.argv[2] ?? 0);
const words = Number(process.argv[3] ?? 24);
if (!Number.isInteger(count) || count < 1) {
  console.error('usage: node src/gen_mnemonics.mjs <count> [wordCount=24]');
  process.exit(1);
}
const strength = words === 12 ? 128 : words === 24 ? 256 : null;
if (strength === null) { console.error('wordCount must be 12 or 24'); process.exit(1); }

for (let i = 0; i < count; i++) {
  const m = bip39.generateMnemonic(wordlist, strength);
  // Belt-and-suspenders: validate what we just generated before emitting it.
  if (!bip39.validateMnemonic(m, wordlist)) { console.error('self-check failed'); process.exit(2); }
  console.log(m);
}
