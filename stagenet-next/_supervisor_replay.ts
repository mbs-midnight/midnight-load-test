// Chain-wide zswapLedgerEvents replay (the wallet SDK's own sync method) to establish ground truth
// for what the stagenet wallet owns. Prints derived public material and coin changes only.
import { readFileSync } from 'node:fs';
import * as ledger from '@midnightntwrk/ledger-v9';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { WebSocket } from 'ws';
const WS = 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';
const env = readFileSync('.env.stagenet', 'utf8');
const secret = env.match(/^MN_STAGENET_SEED=(.*)$/m)![1].trim().replace(/^["']|["']$/g, '');
function seedToBytes(raw: string): Uint8Array {
  if (/\s/.test(raw)) { if (!validateMnemonic(raw, wordlist)) throw new Error('bad mnemonic'); return mnemonicToSeedSync(raw); }
  const hex = raw.replace(/^0x/, ''); return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}
const res = HDWallet.fromSeed(seedToBytes(secret)); if (res.type !== 'seedOk') throw new Error('hd');
const d = res.hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0); if (d.type !== 'keyDerived') throw new Error('derive');
res.hdWallet.clear();
const keys = ledger.ZswapSecretKeys.fromSeed(d.key);
const hex2b = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
let state = new ledger.ZswapLocalState();
let n = 0, maxId = -1, lastId = -1, tags: Record<string, number> = {}, changes = 0;
const t0 = Date.now();
const ws = new WebSocket(WS, 'graphql-transport-ws');
await new Promise<void>((resolve) => {
  let idle: NodeJS.Timeout | undefined;
  const bump = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { ws.close(); resolve(); }, 8000); };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.type === 'connection_ack') { ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription Z($id: Int) { zswapLedgerEvents(id: $id) { id raw maxId protocolVersion } }', variables: { id: null } } })); bump(); return; }
    if (msg.type !== 'next') { console.log(msg.type, JSON.stringify(msg.payload ?? '')); return; }
    bump();
    const e = msg.payload.data.zswapLedgerEvents; n++; maxId = e.maxId; lastId = e.id;
    let ev: ledger.Event;
    try { ev = ledger.Event.deserialize(hex2b(e.raw)); } catch (err) { console.log('deser fail id', e.id, 'pv', e.protocolVersion, String(err).slice(0, 120)); return; }
    const tag = (ev.content as any).tag; tags[tag] = (tags[tag] ?? 0) + 1;
    try {
      const r = state.replayEventsWithChanges(keys, [ev]); state = r.state;
      for (const ch of r.changes) { changes++; console.log(`id=${e.id} tx=${ch.source.slice(0, 16)} recv=[${ch.receivedCoins.map((c) => `${c.value}@${c.type.slice(0, 6)}#${c.mt_index}`)}] spent=[${ch.spentCoins.map((c) => `${c.value}@${c.type.slice(0, 6)}#${c.mt_index}`)}]`); }
    } catch (err) { console.log('replay fail id', e.id, String(err).slice(0, 160)); }
    if (lastId >= maxId) { ws.close(); resolve(); }
  });
  ws.on('error', (e) => { console.log('ws error', e); resolve(); });
  ws.on('close', () => resolve());
});
console.log(`\nevents=${n} lastId=${lastId} maxId=${maxId} in ${((Date.now() - t0) / 1000).toFixed(1)}s tags=${JSON.stringify(tags)} changes=${changes}`);
console.log('firstFree', state.firstFree.toString(), 'spendable coins', state.coins.size);
for (const c of state.coins) console.log('  coin', c.value.toString(), c.type, 'mt', c.mt_index.toString());
process.exit(0);
