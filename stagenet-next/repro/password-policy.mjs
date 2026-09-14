// Defect (migration note): midnight-js 5.x private-state passwords must contain
// 3 of 4 character classes (and no runs of 4 sequential or 3 repeated
// characters). A passphrase that satisfied 4.x's length-only rule now fails at
// deploy time with "Found: N". Offline.
import { validatePassword, MIN_PASSWORD_LENGTH, MIN_CHARACTER_CLASSES, MIN_SEQUENTIAL_LENGTH, MAX_CONSECUTIVE_REPEATED } from '@midnight-ntwrk/midnight-js-utils';

console.log(`policy: length ≥ ${MIN_PASSWORD_LENGTH}, ≥ ${MIN_CHARACTER_CLASSES} character classes, no ${MIN_SEQUENTIAL_LENGTH}-char sequences, no ${MAX_CONSECUTIVE_REPEATED + 1} repeats`);
// No sequential runs (abcd, 1234) and no repeats, so only the class rule differs.
const cases = [
  ['20 lowercase, non-sequential (fine under 4.x)', 'xqmzplwrtvknsjbfhdgc'],
  ['lowercase + digits, 20 chars',                  'xqmzplwrtvknsj7b3h9c'],
  ['lower + upper + digits, 20 chars',              'XqmZplWrtVknSj7b3H9c'],
];
const seen = [];
for (const [label, pw] of cases) {
  try { validatePassword(pw); seen.push([label, 'accepted']); }
  catch (e) { seen.push([label, 'rejected — ' + e.message.split('\n')[0]]); }
}
seen.forEach(([l, s]) => console.log(`  ${l}: ${s}`));
const lengthOnlyRejected = /Found: 1/.test(seen[0][1]) && /Found: 2/.test(seen[1][1]) && seen[2][1] === 'accepted';
if (lengthOnlyRejected) {
  console.log('RESULT password-policy: REPRODUCED — 20-character passwords with 1 or 2 character classes are rejected (Found: 1 / Found: 2); 3 classes pass. 4.x required only length ≥ 16');
  process.exit(0);
}
console.log('RESULT password-policy: NOT REPRODUCED — see cases above');
process.exit(1);
