// Fails if ru/en dictionaries drift: same base keys, same placeholders, all plural forms present.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (l) => JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url)));
const en = load("en");
const ru = load("ru");
const PLURAL = /_(zero|one|two|few|many|other)$/;
const base = (d) => new Set(Object.keys(d).map((k) => k.replace(PLURAL, "")));
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

assert.deepEqual([...base(ru)].sort(), [...base(en)].sort(), "ru and en have different keys");
for (const [k, v] of Object.entries(en)) {
  const r = ru[k] ?? ru[k.replace(PLURAL, "")];
  assert.ok(r, `ru missing ${k}`);
  assert.equal(vars(r), vars(v), `placeholders differ in ${k}`);
}
for (const [lang, d, forms] of [["en", en, ["one", "other"]], ["ru", ru, ["one", "few", "many", "other"]]]) {
  for (const k of Object.keys(d).filter((k) => k.endsWith("_other"))) {
    const b = k.replace(PLURAL, "");
    for (const f of forms) assert.ok(`${b}_${f}` in d, `${lang} missing plural ${b}_${f}`);
  }
}
console.log(`i18n ok: ${base(en).size} keys`);
