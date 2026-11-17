// Run from the repo root:  node tools/selftest.mjs        (Node 18+, needs data/key_retail.bin)
import fs from 'node:fs';
import { parseMasterKeys, loadEditorResources, lookupAbility, SsbuAmiibo } from '../amiibo-editor/ssbu-amiibo.js';

globalThis.fetch = async (u) => ({ ok: true, text: async () => fs.readFileSync(new URL(u), 'utf8') });
const keys = await parseMasterKeys(fs.readFileSync('data/key_retail.bin'));
const res = await loadEditorResources();

for (const f of fs.readdirSync('data/bins').filter((n) => n.endsWith('.bin'))) {
  const a = await SsbuAmiibo.open(keys, res, fs.readFileSync(`data/bins/${f}`));
  await SsbuAmiibo.open(keys, res, await a.export()); // our output must unlock again
  console.log('ok  ', f);
}
let bad = 0;
for (const line of fs.readFileSync('data/spiritList.csv', 'utf8').split(/\r?\n/).filter(Boolean)) {
  const abil = line.replace(/^.*?,\d+,/, '').replace(/^"|"$/g, '');
  for (const part of abil.split('+').map((s) => s.trim()).filter(Boolean))
    if (!lookupAbility(res, part)) { bad++; console.log('NO MATCH:', part); }
}
console.log(bad ? `${bad} unmatched abilities` : 'all spirit abilities resolve');
