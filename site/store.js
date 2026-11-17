// Fișierele panoului din data/ (publicat, nepublicat, istoric, versiuni, brand).
//   fără bază de date: se citesc și se scriu pe disc, ca înainte;
//   cu Neon (DATABASE_URL): stau în tabelul `fisiere`, iar serverul le ține în memorie.
// Un fișier care încă nu e în Neon se citește din git: așa pornește o bază nouă, fără migrare.
// Fișierele derivate (entitățile și brandul de lucru) nu se salvează: se recalculează din cele de mai sus.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA = path.join(__dirname, '..', 'data');
const DERIVED = /^(entitati\.json|entitati-local\.json|brand-local\.json)$/;
const LAZY = /^curare\/versiuni\//; // copiile versiunilor se încarcă doar când e nevoie de ele
// starea rămâne între cereri (modulele site-ului se reîncarcă la fiecare cerere, acesta nu)
const S = (global.__antStore ||= { mem: new Map(), dirty: new Map(), ver: null, checked: 0, derive: null });

const online = () => db.on();
// calea relativă la data/ (cu /), sau null pentru fișierele din afara lui
function rel(f) {
  const r = path.relative(DATA, path.resolve(DATA, f));
  return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
}
const abs = (f) => path.resolve(DATA, f);

function read(f) {
  const r = rel(f);
  if (r && online() && S.mem.has(r)) return S.mem.get(r);
  try { return fs.readFileSync(abs(f), 'utf8'); } catch (e) { return null; }
}
const exists = (f) => read(f) != null;
function write(f, s) {
  const r = rel(f);
  if (r && online()) { S.mem.set(r, s); if (!DERIVED.test(r)) S.dirty.set(r, s); return; }
  fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
  fs.writeFileSync(abs(f), s);
}
function remove(f) {
  const r = rel(f);
  if (r && online()) { S.mem.set(r, null); if (!DERIVED.test(r)) S.dirty.set(r, null); return; }
  if (fs.existsSync(abs(f))) fs.unlinkSync(abs(f));
}
// un număr care se schimbă odată cu datele (pentru cache-uri)
const stamp = () => (online() ? S.ver || '0' : String(fs.statSync(path.join(DATA, 'entitati.json')).mtimeMs));

const VER_SQL = `select coalesce(max(actualizat)::text, '') || '/' || count(*) as v from fisiere where cale not like 'curare/versiuni/%'`;
// aduce din Neon ce s-a schimbat (verificarea costă o interogare mică; cel mult o dată la `minAge` ms)
async function load(minAge = 0) {
  if (!online()) return;
  if (S.ver && Date.now() - S.checked < minAge) return;
  await db.init();
  const [{ v }] = await db.q(VER_SQL);
  S.checked = Date.now();
  if (v === S.ver) return;
  const rows = await db.q(`select cale, continut from fisiere where cale not like 'curare/versiuni/%'`);
  for (const k of [...S.mem.keys()]) if (!LAZY.test(k)) S.mem.delete(k);
  rows.forEach((x) => S.mem.set(x.cale, x.continut));
  S.ver = v;
  if (S.derive) S.derive();
}
// copia unei versiuni (pentru revenire)
async function preload(f) {
  const r = rel(f);
  if (!r || !online() || S.mem.has(r)) return;
  const rows = await db.q('select continut from fisiere where cale = $1', [r]);
  if (rows.length) S.mem.set(r, rows[0].continut);
}
// salvează în Neon tot ce s-a modificat în cererea curentă, într-o singură tranzacție
async function flush() {
  if (!online() || !S.dirty.size) return;
  const list = [...S.dirty].map(([cale, continut]) => ({
    query: 'insert into fisiere (cale, continut, actualizat) values ($1, $2, now()) on conflict (cale) do update set continut = excluded.continut, actualizat = now()',
    params: [cale, continut],
  }));
  S.dirty.clear();
  let res;
  // dacă salvarea eșuează, următoarea cerere reîncarcă totul din Neon (memoria nu rămâne cu ce nu s-a salvat)
  try { res = await db.tx([...list, { query: VER_SQL, params: [] }]); } catch (e) { S.ver = null; throw e; }
  S.ver = res[res.length - 1][0].v;
  S.checked = Date.now();
}
// funcția care recalculează fișierele derivate după ce datele vin din Neon (o setează serverul)
const onLoad = (fn) => { S.derive = fn; };

module.exports = { DATA, online, read, exists, write, remove, stamp, load, preload, flush, onLoad };
