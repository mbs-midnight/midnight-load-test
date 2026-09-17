// Temporary smoke test for the midnight-supervisor live path. Runs inside
// stagenet-next so it borrows its node_modules (ledger-v9 rc.4, wallet-sdk beta.3, ws, graphql-ws).
// Prints ONLY derived public material (address, viewing key) plus decrypted coin changes. Never the seed.
import { readFileSync } from 'node:fs';
import * as ledger from '@midnightntwrk/ledger-v9';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, ShieldedEncryptionSecretKey, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { WebSocket } from 'ws';

const NETWORK_ID = 'stagenet';
const HTTP = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const WS = 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';

const env = readFileSync('.env.stagenet', 'utf8');
const m = env.match(/^MN_STAGENET_SEED=(.*)$/m);
if (!m) throw new Error('no seed');
const secret = m[1].trim().replace(/^["']|["']$/g, '');
function seedToBytes(raw: string): Uint8Array {
  if (/\s/.test(raw)) { if (!validateMnemonic(raw, wordlist)) throw new Error('bad mnemonic'); return mnemonicToSeedSync(raw); }
  const hex = raw.replace(/^0x/, ''); return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}
const res = HDWallet.fromSeed(seedToBytes(secret));
if (res.type !== 'seedOk') throw new Error('hd fail');
const d = res.hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);
if (d.type !== 'keyDerived') throw new Error('derive fail');
res.hdWallet.clear();
const keys = ledger.ZswapSecretKeys.fromSeed(d.key);
const esk = new ShieldedEncryptionSecretKey(keys.encryptionSecretKey);
const viewingKey = ShieldedEncryptionSecretKey.codec.encode(NETWORK_ID, esk).asString();
const addr = new ShieldedAddress(ShieldedCoinPublicKey.fromHexString(keys.coinPublicKey), ShieldedEncryptionPublicKey.fromHexString(keys.encryptionPublicKey));
const address = MidnightBech32m.encode(NETWORK_ID, addr).asString();
console.log('address    =', address);
console.log('viewingKey =', viewingKey);
console.log('shieldedToken raw =', ledger.shieldedToken().raw, ' nativeToken raw =', ledger.nativeToken().raw);

async function gql(query: string, variables: any) {
  const r = await fetch(HTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j: any = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data;
}
const { connect: sessionId } = await gql('mutation C($vk: ViewingKey!) { connect(viewingKey: $vk) }', { vk: viewingKey });
console.log('sessionId  =', sessionId);

const SUB = `subscription S($sid: HexEncoded!, $idx: Int) {
  shieldedTransactions(sessionId: $sid, index: $idx) {
    __typename
    ... on ShieldedTransactionsProgress { highestZswapEndIndex highestCheckedZswapEndIndex highestRelevantZswapEndIndex }
    ... on RelevantTransaction {
      transaction { id hash protocolVersion zswapStartIndex zswapEndIndex fee
        transactionResult { status segments { id success } }
        block { height hash timestamp protocolVersion }
        contractActions { __typename address }
        zswapLedgerEvents { id raw maxId protocolVersion } }
      zswapCollapsedUpdate { startIndex endIndex update protocolVersion }
    }
  }
}`;

let state = new ledger.ZswapLocalState();
let relevant = 0, events = 0;
const hex2b = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const ws = new WebSocket(WS, 'graphql-transport-ws');
const done = new Promise<void>((resolve) => {
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.type === 'connection_ack') ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: SUB, variables: { sid: sessionId, idx: 0 } } }));
    else if (msg.type === 'next') {
      const ev = msg.payload.data.shieldedTransactions;
      if (ev.__typename === 'ShieldedTransactionsProgress') { console.log('progress', JSON.stringify(ev)); if (ev.highestRelevantZswapEndIndex === 0 || relevant > 0) { if (relevant > 0 || ev.highestCheckedZswapEndIndex >= ev.highestZswapEndIndex) { ws.close(); resolve(); } } return; }
      relevant++;
      const tx = ev.transaction;
      console.log(`\n#${relevant} tx ${tx.hash.slice(0, 12)} block ${tx.block.height} ts=${new Date(tx.block.timestamp).toISOString()} status=${tx.transactionResult.status} zswap[${tx.zswapStartIndex},${tx.zswapEndIndex}) events=${tx.zswapLedgerEvents.length} fee=${tx.fee} collapsed=${!!ev.zswapCollapsedUpdate} contracts=${tx.contractActions.map((c: any) => c.__typename).join(',')}`);
      if (ev.zswapCollapsedUpdate) {
        try { state = state.applyCollapsedUpdate(ledger.MerkleTreeCollapsedUpdate.deserialize(hex2b(ev.zswapCollapsedUpdate.update))); console.log('  applied collapsed update', ev.zswapCollapsedUpdate.startIndex, '->', ev.zswapCollapsedUpdate.endIndex, 'firstFree now', state.firstFree); }
        catch (e) { console.log('  collapsed update FAILED', String(e)); }
      }
      const evs: ledger.Event[] = [];
      for (const e of tx.zswapLedgerEvents) { try { evs.push(ledger.Event.deserialize(hex2b(e.raw))); } catch (err) { console.log('  event deser failed', e.id, String(err)); } }
      events += evs.length;
      console.log('  event tags:', evs.map((e) => (e.content as any).tag).join(','));
      try {
        const r = state.replayEventsWithChanges(keys, evs);
        state = r.state;
        for (const ch of r.changes) {
          console.log('  change source', ch.source.slice(0, 12), 'received', ch.receivedCoins.map((c) => `${c.value}@${c.type.slice(0, 8)} mt=${c.mt_index}`), 'spent', ch.spentCoins.map((c) => `${c.value}@${c.type.slice(0, 8)} mt=${c.mt_index}`));
        }
        console.log('  firstFree', state.firstFree, 'coins', state.coins.size);
      } catch (err) { console.log('  replay FAILED', String(err)); }
    } else if (msg.type === 'error' || msg.type === 'complete') { console.log(msg.type, JSON.stringify(msg.payload ?? '')); ws.close(); resolve(); }
  });
  ws.on('error', (e) => { console.log('ws error', e); resolve(); });
});
await Promise.race([done, new Promise((r) => setTimeout(r, 90_000))]);
console.log(`\nrelevant=${relevant} events=${events} spendable coins=${state.coins.size}`);
for (const c of state.coins) console.log('  coin', c.value.toString(), c.type, 'mt', c.mt_index.toString());
await gql('mutation D($id: HexEncoded!) { disconnect(sessionId: $id) }', { id: sessionId });
process.exit(0);
