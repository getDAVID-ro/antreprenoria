// npm run blob:copy — mută imaginile încărcate din panou în Blob-ul vostru și rescrie adresele lor în datele panoului (Neon).
//
// Citește din .env.local (îl aduce `npx vercel env pull .env.local`):
//   DATABASE_URL          baza Neon a proiectului (vine odată cu proiectul)
//   BLOB_READ_WRITE_TOKEN Blob-ul vostru, nou
//   DWF_BLOB_TOKEN        (opțional) Blob-ul DWF, dacă proiectul are unul: din el doar citește
//
// Surse: imaginile din tabelul `imagini` (Neon, unde ajung cât proiectul n-are Blob) și, dacă există, Blob-ul DWF.
// Imaginile site-ului din git (site/assets) rămân în git: nu trebuie mutate.
// Se poate rula de oricâte ori: fișierele deja copiate (aceeași cale, aceeași mărime) sunt sărite.
// Fără pachete: Vercel CLI prin npx (Node 20.12+; recomandat 24).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ENV_FILE = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const db = require('../site/db');
const OLD = (process.env.DWF_BLOB_TOKEN || '').trim();
const NEW = (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const PARALLEL = 4;
const storeId = (t) => t.split('_')[3] || '';

function stop(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
if (!NEW) stop('Lipsește BLOB_READ_WRITE_TOKEN în .env.local. Creați Blob-ul vostru (Storage → Create → Blob, public, Frankfurt, legat de proiect, cu Development bifat), apoi: npx vercel env pull .env.local');
if (OLD && storeId(OLD) === storeId(NEW)) stop('BLOB_READ_WRITE_TOKEN este încă tokenul depozitului DWF. Ștergeți-l din proiect (Settings → Environment Variables), creați Blob-ul vostru, apoi: npx vercel env pull .env.local');
if (!db.on()) stop('Lipsește DATABASE_URL în .env.local. Rulați: npx vercel env pull .env.local');

const WIN = process.platform === 'win32';
const hide = (t) => [OLD, NEW, process.env.DATABASE_URL].filter(Boolean).reduce((s, x) => s.split(x).join('<token>'), String(t)).replace(/^<claude-code-hint[^\n]*\n?/gm, '').trim();
// Vercel CLI prin npx; pe Windows npx e un .cmd, deci pornește prin shell, ca o singură linie de comandă
function vercel(args) {
  return new Promise((ok, bad) => {
    const cmd = ['--yes', 'vercel', ...args], opts = { stdio: ['ignore', 'pipe', 'pipe'] };
    const child = WIN ? spawn(['npx', ...cmd.map((a) => `"${a}"`)].join(' '), { ...opts, shell: true }) : spawn('npx', cmd, opts);
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', bad);
    child.on('close', (code) => (code === 0 ? ok(out) : bad(new Error(hide(err.trim() || out.trim() || `vercel a ieșit cu codul ${code}`)))));
  });
}
async function list(token) {
  const blobs = [];
  let next = null;
  do {
    const args = ['blob', 'list', '--json', '--limit', '1000', '--rw-token', token];
    if (next) args.push('--next', next);
    const out = await vercel(args);
    const page = JSON.parse(out.slice(out.indexOf('{')));
    blobs.push(...page.blobs);
    next = (page.pagination && page.pagination.next) || null;
  } while (next);
  return blobs;
}
async function put(tmp, pathname, data, type) {
  const file = path.join(tmp, Math.random().toString(36).slice(2) + path.extname(pathname));
  fs.writeFileSync(file, data);
  const args = ['blob', 'put', file, '--pathname', pathname, '--access', 'public', '--force', '--no-multipart'];
  if (type) args.push('--content-type', type);
  try { await vercel([...args, '--rw-token', NEW]); } finally { fs.rmSync(file, { force: true }); }
}
// adresa veche -> adresa nouă, în toate fișierele panoului din Neon (publicat, nepublicat, istoric, brand)
async function rewrite(from, to) {
  const rows = await db.q('update fisiere set continut = replace(continut, $1, $2), actualizat = now() where strpos(continut, $1) > 0 returning cale', [from, to]);
  return rows.length;
}

async function main() {
  await db.init();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-copy-'));
  const jobs = [];
  // 1. imaginile din Neon (încărcate din panou cât proiectul n-a avut Blob)
  const neon = await db.q('select cale, tip, length(date) as n from imagini order by cale');
  neon.forEach((x) => jobs.push({ sursa: 'Neon', pathname: `uploads/${x.cale}`, veche: `/assets/uploads/${x.cale}`, tip: x.tip,
    date: async () => Buffer.from((await db.q('select date from imagini where cale = $1', [x.cale]))[0].date, 'base64') }));
  // 2. Blob-ul DWF, dacă proiectul are unul
  let oldBlobs = [];
  if (OLD) {
    oldBlobs = await list(OLD);
    oldBlobs.forEach((b) => jobs.push({ sursa: 'Blob DWF', pathname: b.pathname, veche: b.url, size: b.size,
      date: async () => { const r = await fetch(b.url, { cache: 'no-store' }); if (!r.ok) throw new Error(`descărcarea a răspuns ${r.status}`); const d = Buffer.from(await r.arrayBuffer()); if (d.length !== b.size) throw new Error(`am descărcat ${d.length} B în loc de ${b.size} B`); return d; } }));
  }
  console.log(`De mutat: ${neon.length} imagini din Neon${OLD ? ` și ${oldBlobs.length} fișiere din Blob-ul DWF` : ''}.`);
  if (!jobs.length) { console.log('\n✓ Nu e nimic de copiat: imaginile site-ului sunt în git, iar din panou nu s-a încărcat nimic.'); fs.rmSync(tmp, { recursive: true, force: true }); return; }

  const have = new Map((await list(NEW)).map((b) => [b.pathname, b.size]));
  const queue = [...jobs];
  let done = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        try {
          const data = await j.date();
          j.size = data.length;
          if (have.get(j.pathname) === data.length) { console.log(`  = ${j.pathname} (deja copiat)`); continue; }
          await put(tmp, j.pathname, data, j.tip);
          console.log(`  ↑ ${++done} ${j.pathname} (${j.sursa})`);
        } catch (e) { console.error(`  ✗ ${j.pathname}: ${hide(e.message)}`); }
      }
    }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  console.log('\nVerific fiecare fișier în Blob-ul vostru și rescriu adresele…');
  const now = new Map((await list(NEW)).map((b) => [b.pathname, b]));
  let ok = 0, refs = 0;
  for (const j of jobs) {
    const n = now.get(j.pathname);
    if (n && n.size === j.size) { ok++; refs += await rewrite(j.veche, n.url); console.log(`  ✓ ${j.pathname} (${j.size} B)`); }
    else console.log(`  ✗ ${j.pathname}: ${n ? `are ${n.size} B în loc de ${j.size} B` : 'lipsește'}`);
  }
  if (ok !== jobs.length) stop(`${jobs.length - ok} din ${jobs.length} fișiere nu s-au copiat. Rulați din nou: npm run blob:copy`);
  console.log(`\n✓ Gata: toate cele ${jobs.length} fișiere sunt în Blob-ul vostru; adresele s-au actualizat în ${refs} fișiere ale panoului.`);
}

main().catch((e) => stop(`Copierea s-a oprit: ${hide(e && e.message ? e.message : e)}`));
