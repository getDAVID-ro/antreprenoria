// Server local fără dependențe.
//   /                   -> homepage-ul noului site, generat din creier (site/render.js); ?brand=<id> = previzualizare
//   /assets/brand.css   -> culorile, fonturile și formele, generate din data/brand.json
//   /assets/...         -> CSS/JS ale site-ului (site/assets)
//   /manage[/...]       -> panoul de administrare (manage/index.html): dashboard, entități, branding
//   GET /api/entitati   -> data/entitati.json (generat de npm run sync)
//   GET /api/brand      -> data/brand.json        PUT /api/brand/activ {id} -> schimbă varianta folosită pe site
//   PUT /api/brand/icon {activ?, culori?}         -> iconul de meniu pe mobil și modul lui de culoare
//   POST /api/aplica    -> aplicarea în pași de pe /aplica, salvată în Neon (GET ?reia=<token> o reia)     GET /api/aplicari -> lista pentru panou (doar local)
// Cu baza de date (DATABASE_URL, Neon): panoul merge și online, modificările și aplicările stau în Neon (site/db.js, site/store.js).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3200;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const JSON_FILES = { '/api/entitati': 'entitati.json', '/api/brand': 'brand.json' };

// .env.local (doar local, exclus din git; `vercel env pull` îl completează): DATABASE_URL = baza Neon, BLOB_READ_WRITE_TOKEN = Blob
try {
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach((l) => { const m = /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
} catch (e) {}
const db = require('./site/db');
const store = require('./site/store');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
// cache: local, browserul verifică fișierul la fiecare încărcare (modificările apar imediat);
// pe Vercel, fișierul cerut cu ?v=<versiune> se păstrează un an (versiunea se schimbă odată cu el), restul o oră în browser și o zi pe CDN
function sendFile(res, file, versioned = false) {
  const cache = !READ_ONLY ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 – ' + path.relative(ROOT, file || ''));
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}
function body(req) {
  return new Promise((ok, err) => {
    let b = '';
    // peste 1 MB: restul se citește și se aruncă, iar cererea primește un răspuns de eroare (nu rămâne agățată)
    let big = false;
    req.on('data', (c) => { if (big) return; b += c; if (b.length > 1e6) { big = true; b = ''; err(new Error('prea mare')); } });
    req.on('end', () => { if (big) return; try { ok(b ? JSON.parse(b) : {}); } catch (e) { err(e); } });
  });
}
// limita de trimiteri pe formulare: cel mult `max` cereri în `min` minute de la aceeași adresă IP
const HITS = new Map();
function tooMany(req, key, max, min) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), k = key + '|' + ip, list = (HITS.get(k) || []).filter((t) => now - t < min * 60e3);
  list.push(now); HITS.set(k, list);
  if (HITS.size > 5000) for (const [x, l] of HITS) if (!l.some((t) => now - t < 60 * 60e3)) HITS.delete(x);
  return list.length > max;
}
// aplicarea în pași, în Neon: cu tokenul unei aplicări neterminate o completează, altfel începe una nouă; întoarce tokenul
async function saveAplicare(rec) {
  if (!db.on()) throw new Error('fără DATABASE_URL');
  await db.init();
  const rows = await db.q(`with p as (select $1::jsonb as p),
    upd as (
      update aplicari a set nume = p->>'nume', email = p->>'email', telefon = p->>'telefon', companie = p->>'companie', cui = p->>'cui',
        cifra_afaceri = p->>'cifra_afaceri', editie = p->>'editie', sursa = p->>'sursa', sursa_alta = p->>'sursa_alta',
        raspunsuri = coalesce(p->'raspunsuri', '{}'::jsonb), pas = greatest(a.pas, coalesce((p->>'pas')::int, 1)),
        finalizata = coalesce((p->>'finalizata')::boolean, false),
        stare = case when coalesce((p->>'finalizata')::boolean, false) then 'nouă' else a.stare end, actualizat = now()
      from p where a.token = nullif(p->>'token', '')::uuid and not a.finalizata
      returning a.token),
    ins as (
      insert into aplicari (nume, email, telefon, companie, cui, cifra_afaceri, editie, sursa, sursa_alta, acord, sursa_pagina, raspunsuri, pas, finalizata, stare)
      select p->>'nume', p->>'email', p->>'telefon', p->>'companie', p->>'cui', p->>'cifra_afaceri', p->>'editie', p->>'sursa', p->>'sursa_alta', true, p->>'sursa_pagina',
        coalesce(p->'raspunsuri', '{}'::jsonb), coalesce((p->>'pas')::int, 1), coalesce((p->>'finalizata')::boolean, false),
        case when coalesce((p->>'finalizata')::boolean, false) then 'nouă' else 'incompletă' end
      from p where not exists (select 1 from upd)
      returning token)
    select token::text as t from upd union all select token::text from ins`, [JSON.stringify(rec)]);
  return rows[0] && rows[0].t;
}
// încărcarea unei imagini în Vercel Blob (public, fără sufix aleatoriu), prin API-ul HTTP, fără pachete; întoarce adresa sau null
async function blobPut(pathname, buf, type) {
  const headers = { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`, 'x-api-version': '11', 'x-content-type': type,
    'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-vercel-blob-access': 'public' };
  for (const u of [`https://vercel.com/api/blob/?pathname=${encodeURIComponent(pathname)}`, `https://blob.vercel-storage.com/${pathname}`]) {
    const r = await fetch(u, { method: 'PUT', body: buf, headers, signal: AbortSignal.timeout(20e3) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j && j.url) return j.url;
  }
  return null;
}
// Previne ieșirea din directorul permis (../).
function safe(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}
// modulele site-ului se reîncarcă la fiecare cerere, ca schimbările din data/ și site/ să apară fără repornire
function fresh(mod) {
  ['./site/render', './site/brand', './site/menu', './site/home', './site/util', './site/edition', './site/program', './site/despre', './site/teme', './site/aplica', './site/texte', './site/traineri', './site/alumni', './site/parteneri', './site/implicare', './site/editii', './site/home2', './site/despre2', './site/home3', './site/comunitate', './site/redirects'].forEach((m) => delete require.cache[require.resolve(m)]);
  return require(mod);
}

// pe Vercel fișierele sunt doar pentru citire: fără bază de date, modificările din panou se fac local și ajung pe site prin git push;
// cu Neon, panoul se folosește și online, iar „Publică” schimbă site-ul imediat
const READ_ONLY = !!process.env.VERCEL && !db.on();
const ONLINE = db.on();
const AL_RE = /^\/comunitate\/([a-z0-9-]+)\/?$/;

// ---------- CMS: modificările din panou ----------
// data/curare/editari.json       = ce e PUBLICAT (pe git; Vercel construiește site-ul din el)
// data/curare/editari-local.json = jurnalul modificărilor încă nepublicate, fiecare cu schimbările ei (doar local)
// Local, site-ul și panoul folosesc starea de lucru = publicat + jurnal (data/entitati-local.json).
const EDITARI = path.join(DATA, 'curare', 'editari.json');
const JURNAL = path.join(DATA, 'curare', 'editari-local.json');
// scripts/ rămâne doar local (.vercelignore): îl încărcăm la cerere, nu la build; pe Vercel panoul doar citește
const script = (n) => require(path.join(ROOT, 'scripts', n));
const EMPTY_EDITARI = () => ({ modificari: {}, program: {}, metodologie: null, cifre: null, agende: {}, participanti: {}, parteneri: {}, ascunse: [], texte: {} });
// fișierele din data/ trec prin site/store.js (disc sau Neon)
const readJson = (f, def) => { try { const s = store.read(f); return s == null ? def : JSON.parse(s); } catch (e) { return def; } };
function readPublished() {
  const E = readJson(EDITARI, {});
  try { return script('editari').published(E); } catch (e) { return { ...EMPTY_EDITARI(), ...E }; }
}
const readJurnal = () => { const J = readJson(JURNAL, null); return J && Array.isArray(J.intrari) ? J : { intrari: [] }; };
// starea de lucru: publicat + toate modificările din jurnal
function readEditari() {
  const P = readPublished();
  try { return script('editari').working(P, readJurnal()); } catch (e) { return P; }
}
// entitățile se reconstruiesc imediat, ca site-ul local și panoul să arate modificarea
// brandul (culori, fonturi, forme, logo): publicat în data/brand.json; local, plus modificările nepublicate = data/brand-local.json
const BRAND = path.join(DATA, 'brand.json'), BRAND_LOCAL = path.join(DATA, 'brand-local.json');
const BRAND_SECT = ['culori', 'tipografie', 'forme', 'google_fonts', 'logo', 'stil'];
const patchBrand = (B, list) => { list.forEach((x) => { const v = B.variante.find((y) => y.id === x.p[0]); if (v && BRAND_SECT.includes(x.p[1])) v[x.p[1]] = JSON.parse(JSON.stringify(x.v)); }); return B; };
const brandWorking = () => readJurnal().intrari.filter((x) => x.tinta === 'brand').reduce((B, x) => patchBrand(B, x.patch), readJson(BRAND, { variante: [] }));
function writeBrandLocal() {
  const has = readJurnal().intrari.some((x) => x.tinta === 'brand');
  if (has) writeJson(BRAND_LOCAL, brandWorking()); else store.remove(BRAND_LOCAL);
}
// entitățile = baza (din site-ul vechi + curare, data/entitati-baza.json, făcută de scripts/build-entities.js) + modificările din panou.
// Cu Neon se calculează aici, în memorie; fără, le reface scriptul de build, pe disc.
const BAZA = path.join(DATA, 'entitati-baza.json');
function deriveEntities() {
  const ED = script('editari'), base = fs.readFileSync(BAZA, 'utf8');
  const pub = ED.published(readJson(EDITARI, {})), J = readJurnal();
  store.write(path.join(DATA, 'entitati.json'), JSON.stringify(ED.apply(JSON.parse(base), pub)));
  if (J.intrari.length) store.write(DATA_LOCAL, JSON.stringify(ED.apply(JSON.parse(base), ED.working(pub, J))));
  else store.remove(DATA_LOCAL);
  writeBrandLocal();
}
store.onLoad(deriveEntities);
const rebuild = () => {
  if (ONLINE) return deriveEntities();
  require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-entities.js')], { cwd: ROOT, stdio: 'ignore' });
  writeBrandLocal();
};
const writeJson = (f, v) => store.write(f, JSON.stringify(v, null, 2) + '\n');
// lista pentru panou: fiecare modificare nepublicată, cu eticheta și grupul ei (o salvare din panou poate avea mai multe)
const pendingList = () => readJurnal().intrari.map(({ id, cand, ce, grup }) => ({ id, cand, ce, grup }));
// istoricul publicărilor: după fiecare publicare se păstrează o copie a datelor publicate (o „versiune”),
// ca site-ul să poată reveni la ea. data/curare/istoric.json = lista; data/curare/versiuni/<id>.json = copiile.
const ISTORIC = path.join(DATA, 'curare', 'istoric.json');
const VERSIUNI = path.join(DATA, 'curare', 'versiuni');
const readIstoric = () => { const H = readJson(ISTORIC, null); return H && Array.isArray(H.versiuni) ? H : { versiuni: [] }; };
function saveVersion(P, info) {
  const H = readIstoric();
  // prima dată: starea de dinainte devine „versiunea de pornire”, ca să existe mereu unde reveni
  if (!H.versiuni.length && info.inainte) {
    const id0 = 'v0-' + Date.now().toString(36);
    writeJson(path.join(VERSIUNI, id0 + '.json'), info.inainte);
    if (info.inainteBrand) writeJson(path.join(VERSIUNI, id0 + '.brand.json'), info.inainteBrand);
    H.versiuni.push({ id: id0, cand: new Date(Date.now() - 1000).toISOString(), tip: 'pornire', ce: ['Starea de dinainte de istoric'] });
  }
  const id = 'v' + (H.versiuni.length) + '-' + Date.now().toString(36);
  writeJson(path.join(VERSIUNI, id + '.json'), P);
  writeJson(path.join(VERSIUNI, id + '.brand.json'), readJson(BRAND, null));
  H.versiuni.push({ id, cand: new Date().toISOString(), tip: info.tip, ce: info.ce, din: info.din || null });
  writeJson(ISTORIC, H);
  return id;
}
const gitPublish = (msg) => {
  // cu Neon, publicarea înseamnă salvarea în baza de date: site-ul o arată imediat, fără git
  if (ONLINE) return;
  const { execFileSync } = require('child_process');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', 'data/curare/editari.json', 'data/entitati.json', 'data/brand.json', 'data/curare/istoric.json', 'data/curare/versiuni', ...(fs.existsSync(path.join(ROOT, 'site', 'assets', 'uploads')) ? ['site/assets/uploads'] : []));
  git('commit', '-m', msg);
  git('push', 'origin', 'main');
};
const PUB_NOTE = 'Modificările PUBLICATE din panou. Cele nepublicate stau în editari-local.json (doar local). Vezi scripts/editari.js.';
// datele de lucru local, cele publicate pe Vercel
const DATA_LOCAL = path.join(DATA, 'entitati-local.json');
const dataFile = () => (!READ_ONLY && store.exists(DATA_LOCAL) ? DATA_LOCAL : path.join(DATA, 'entitati.json'));
const CMS_TIPURI = ['oameni', 'organizatii', 'editii', 'ateliere', 'locatii', 'teme', 'echipa'];
function cmsEdit(b) {
  const E = readEditari(), D = JSON.parse(store.read(dataFile()));
  const before = JSON.parse(JSON.stringify(E));
  const { slug } = script('lib');
  const exists = (tip, id) => (tip === 'echipa' ? D.program.contact.echipa : tip === 'ateliere' ? D.editii.flatMap((e) => e.ateliere) : D[tip]).some((x) => x.id === id) || !!E.modificari[tip]?.[id];
  let id = b.id;
  switch (b.op) {
    case 'entitate': {
      if (b.tip === 'program') { Object.assign(E.program, b.date || {}); break; }
      if (b.tip === 'metodologie' || b.tip === 'cifre') { if (!Array.isArray(b.lista)) return { error: 'lipsește lista' }; E[b.tip] = b.lista; break; }
      if (!CMS_TIPURI.includes(b.tip)) return { error: 'tip necunoscut' };
      const date = { ...(b.date || {}) };
      if (b.nou) {
        if (b.tip === 'ateliere') {
          const ed = D.editii.find((e) => e.id === b.editie);
          if (!ed) return { error: 'Alege cohorta atelierului.' };
          const nr = Math.max(0, ...ed.ateliere.map((a) => a.nr)) + 1;
          id = `${ed.id}-a${nr}`; Object.assign(date, { nr, _nou: true, _editie: ed.id });
        } else if (b.tip === 'editii') {
          if (!date.numar) return { error: 'Scrie numărul cohortei.' };
          id = `${date.serie === 'Cluj' ? 'cluj' : 'bucuresti'}-${date.numar}`;
          if (exists('editii', id)) return { error: 'Cohorta există deja.' };
          date._nou = true;
          // o cohortă nouă nu apare pe site până nu e gata (pasul „Pe site” din constructor)
          if (!E.ascunse.includes(`editii:${id}`)) E.ascunse.push(`editii:${id}`);
        } else {
          const base = slug(date.nume || date.titlu || '');
          if (!base) return { error: 'Scrie numele.' };
          id = base; let i = 2;
          while (exists(b.tip, id)) id = `${base}-${i++}`;
          date._nou = true;
        }
      }
      if (!id) return { error: 'lipsește id-ul' };
      E.modificari[b.tip][id] = { ...(E.modificari[b.tip][id] || {}), ...date };
      break;
    }
    case 'ascuns': {
      const k = `${b.tip}:${b.id}`;
      E.ascunse = E.ascunse.filter((x) => x !== k);
      if (b.ascuns) E.ascunse.push(k);
      break;
    }
    case 'sterge': {
      // se pot șterge doar elementele adăugate din panou; cele preluate din site-ul vechi se ascund
      if (!E.modificari[b.tip]?.[b.id]?._nou) return { error: 'Doar ce ai adăugat din panou se poate șterge. Restul se poate ascunde.' };
      delete E.modificari[b.tip][b.id];
      break;
    }
    case 'agenda': case 'participanti': case 'parteneri': {
      if (!Array.isArray(b.lista)) return { error: 'lipsește lista' };
      E[b.op === 'agenda' ? 'agende' : b.op][b.id] = b.lista;
      break;
    }
    case 'texte': Object.assign(E.texte, b.texte || {}); break;
    // ordinea echipei (pe /despre și în contacte)
    // brandul: o secțiune a unei variante (culori, tipografie, forme, logo; google_fonts merge cu tipografia)
    case 'brand': {
      const Bw = brandWorking(), v = Bw.variante.find((x) => x.id === b.varianta);
      if (!v) return { error: 'Variantă inexistentă.' };
      const changes = Object.entries(b.valori || {}).filter(([k, val]) => BRAND_SECT.includes(k) && JSON.stringify(v[k]) !== JSON.stringify(val)).map(([k, val]) => ({ p: [v.id, k], v: val }));
      if (changes.length) {
        const J = readJurnal(), eid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        J.intrari.push({ id: eid, tinta: 'brand', cand: new Date().toISOString(), ce: String(b.eticheta || 'brand').slice(0, 140), grup: String(b.grup || eid).slice(0, 40), patch: changes });
        writeJson(JURNAL, J);
        writeBrandLocal();
      }
      return { ok: true, nepublicate: pendingList() };
    }
    case 'ordine_echipa': if (!Array.isArray(b.lista)) return { error: 'lipsește lista' }; E.ordine_echipa = b.lista.map(String); break;
    // constructorul de cohortă: copiază structura altei cohorte (atelierele cu temele și agenda, beneficiile, prețul)
    case 'copiaza': {
      const tinta = D.editii.find((e) => e.id === b.id), sursa = D.editii.find((e) => e.id === b.din);
      if (!tinta || !sursa) return { error: 'Cohortă inexistentă.' };
      const ce = b.ce || {};
      if (ce.ateliere) {
        let nr = Math.max(0, ...tinta.ateliere.map((a) => a.nr));
        for (const a of sursa.ateliere.slice().sort((x, y) => x.nr - y.nr)) {
          nr += 1;
          const aid = `${tinta.id}-a${nr}`;
          E.modificari.ateliere[aid] = { _nou: true, _editie: tinta.id, nr, titlu: a.titlu, tema: a.tema, format: a.format, descriere: a.descriere, data: null, data_text: null,
            loc: ce.locatii ? a.loc : null, locatie: ce.locatii ? a.locatie : null, sponsor: null, cauta_sponsor: false };
          E.agende[aid] = (a.program || []).map((m) => ({ interval: m.interval, activitate: m.activitate, speakeri: ce.oameni ? m.speakeri : [] }));
        }
      }
      const p = (E.modificari.editii[tinta.id] ||= {});
      if (ce.beneficii) p.beneficii = [...sursa.beneficii];
      if (ce.preturi) p.preturi = sursa.preturi.filter((x) => !x.ascuns).map((x) => ({ ...x, nota: null }));
      if (ce.preturi && sursa.valoare_estimata) p.valoare_estimata = sursa.valoare_estimata;
      break;
    }
    default: return { error: 'operație necunoscută' };
  }
  // în jurnal intră doar ce s-a schimbat de fapt; publicat rămâne neatins până la „Publică”
  const changes = script('editari').diff(before, E);
  if (changes.length) {
    const J = readJurnal();
    const eid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    J.intrari.push({ id: eid, cand: new Date().toISOString(), ce: String(b.eticheta || 'modificare').slice(0, 140), grup: String(b.grup || eid).slice(0, 40), patch: changes });
    writeJson(JURNAL, J);
    rebuild();
  }
  return { ok: true, id, nepublicate: pendingList() };
}

async function handler(req, res) {
  const [rawPath, query = ''] = req.url.split('#')[0].split('?');
  const url = decodeURIComponent(rawPath);
  // paginile site-ului: săgețile din text devin săgeata desenată a butoanelor (site/util.js › arrows)
  if (!/^\/(manage|api|assets)(\/|$)/.test(url)) {
    const end = res.end.bind(res);
    res.end = (body, ...rest) => {
      // antetele vin prin writeHead (nu se pot citi după), așa că recunoaștem paginile după început
      return end(typeof body === 'string' && /^\s*<!doctype html/i.test(body) ? fresh('./site/util').finishHtml(body) : body, ...rest);
    };
  }
  try {
    // cu Neon: datele panoului se aduc la zi înainte de răspuns (panoul și API-ul mereu; paginile cel mult o dată la 2 secunde)
    if (ONLINE && (!url.startsWith('/assets/') || url === '/assets/brand.css')) {
      const live = /^\/(api|manage)(\/|$)/.test(url) || req.method !== 'GET';
      // dacă Neon nu răspunde, paginile merg mai departe cu ultimele date avute (salvările vor da eroare)
      await store.load(live ? 0 : 2000).catch((e) => console.error('Neon indisponibil:', e.message));
    }
    // adresele site-ului vechi (antreprenoria.ro) duc, într-un singur pas, la pagina nouă potrivită (site/redirects.js)
    if ((req.method === 'GET' || req.method === 'HEAD') && !/^\/(api|assets|manage)(\/|$)/.test(url)) {
      const to = fresh('./site/redirects').oldUrl(url);
      if (to) { res.writeHead(301, { Location: to }); return res.end(); }
    }
    // o singură adresă pentru fiecare pagină: /program/ duce la /program (API-ul, fișierele și panoul rămân cum sunt)
    if ((req.method === 'GET' || req.method === 'HEAD') && url.length > 1 && url.endsWith('/') && !/^\/(api|assets|manage)(\/|$)/.test(url)) {
      res.writeHead(301, { Location: url.replace(/\/+$/, '') + (query ? '?' + query : '') });
      return res.end();
    }
    if (req.method === 'GET' && JSON_FILES[url]) {
      const f = url === '/api/entitati' ? dataFile() : url === '/api/brand' && !READ_ONLY && store.exists(BRAND_LOCAL) ? BRAND_LOCAL : path.join(DATA, JSON_FILES[url]);
      const s = store.read(f);
      return s != null ? sendJson(res, 200, s) : sendJson(res, 404, { error: 'lipsește ' + JSON_FILES[url] });
    }
    // aplicarea în pași: fiecare pas trimis se salvează (pasul 1 = contactul, pentru remindere); la final, finalizata = true
    if (url === '/api/aplica' && req.method === 'POST') {
      if (tooMany(req, 'aplica', 40, 10)) return sendJson(res, 429, { error: 'Prea multe trimiteri. Încearcă din nou peste câteva minute.' });
      const input = await body(req).catch(() => null);
      if (!input) return sendJson(res, 400, { error: 'Cerere invalidă.' });
      if (input.website) return sendJson(res, 200, { ok: true }); // câmpul-capcană pentru roboți
      const ap = fresh('./site/aplica'), render = fresh('./site/render');
      const ids = render.applyOptions().map((o) => o.id);
      const finalizata = input.final === true;
      const pas = finalizata ? ap.STEPS.length : Math.min(Math.max(parseInt(input.pas, 10) || 1, 1), ap.STEPS.length);
      const v = ap.validate(input, ids, pas);
      if (!v.ok) return sendJson(res, 422, { error: 'Verifică câmpurile marcate.', errors: v.errors });
      const token = /^[0-9a-f-]{36}$/i.test(input.token || '') ? input.token : null;
      const rec = ap.record(v.data, { token, pas, finalizata, pagina: String(req.headers.referer || '').slice(0, 300) });
      // aplicările merg în Neon (tabelul aplicari): cu token, se completează aplicarea începută; una trimisă nu se mai modifică
      const t = await saveAplicare(rec).catch((e) => { console.error('aplicare nesalvată', e.message); return null; });
      if (!t) return sendJson(res, 503, { error: 'nedisponibil' });
      return sendJson(res, 200, { ok: true, token: t });
    }
    // reluarea unei aplicări neterminate din linkul de reminder (/aplica?reia=<token>): doar cu tokenul, doar cât nu e trimisă
    if (url === '/api/aplica' && req.method === 'GET') {
      const t = new URLSearchParams(query).get('reia') || '';
      if (!/^[0-9a-f-]{36}$/i.test(t)) return sendJson(res, 400, { error: 'Link invalid.' });
      const rows = db.on() ? await db.q(`select (jsonb_build_object('nume', nume, 'email', email, 'telefon', telefon, 'companie', companie, 'cui', cui,
        'cifra_afaceri', cifra_afaceri, 'editie', editie, 'sursa', sursa, 'sursa_alta', sursa_alta, 'pas', pas) || raspunsuri)::text as j
        from aplicari where token = $1::uuid and not finalizata`, [t]).catch(() => []) : [];
      return rows.length ? sendJson(res, 200, rows[0].j) : sendJson(res, 404, { error: 'Aplicarea nu mai poate fi reluată.' });
    }
    // starea stocării, pentru transfer (docs/transfer-client.md): ce bază și ce Blob folosește site-ul; nu arată niciun token
    if (url === '/api/stare' && req.method === 'GET') {
      const B = process.env.BLOB_READ_WRITE_TOKEN || '', D = process.env.DWF_BLOB_TOKEN || '', sid = (t) => t.split('_')[3] || '';
      let imagini = null;
      if (db.on()) imagini = await db.init().then(() => db.q('select count(*)::int as n from imagini')).then((r) => Number(r[0].n), () => null);
      return sendJson(res, 200, {
        neon: db.on(),
        blob: !B ? 'niciunul (imaginile încărcate din panou stau în Neon)' : D && sid(D) === sid(B) ? 'BLOB_READ_WRITE_TOKEN (încă depozitul DWF)' : 'BLOB_READ_WRITE_TOKEN',
        imagini_in_neon: imagini,
        regiune: process.env.VERCEL_REGION || 'local',
      });
    }
    // întrebările aplicării, pentru etichetele din panou (Leads)
    if (url === '/api/aplica-model' && req.method === 'GET') return sendJson(res, 200, fresh('./site/aplica').STEPS);
    // formularul „Susține programul” (/parteneri): sponsorizare, găzduire, mentorat; salvat în Neon (tabelul implicari)
    if (url === '/api/implicare' && req.method === 'POST') {
      if (tooMany(req, 'implicare', 5, 10)) return sendJson(res, 429, { error: 'Prea multe trimiteri. Încearcă din nou peste câteva minute.' });
      const input = await body(req).catch(() => null);
      if (!input) return sendJson(res, 400, { error: 'Cerere invalidă.' });
      if (input.website) return sendJson(res, 200, { ok: true }); // câmpul-capcană pentru roboți
      const v = fresh('./site/implicare').validate(input);
      if (!v.ok) return sendJson(res, 422, { error: 'Verifică câmpurile marcate.', errors: v.errors });
      const d = v.data;
      const rec = { tip: d.tip, nume: d.nume, companie: d.companie, functie: d.functie || null, email: d.email, telefon: d.telefon || null, mesaj: d.mesaj || null, acord: true, sursa_pagina: String(req.headers.referer || '').slice(0, 300) || null };
      const ok = db.on() && await db.init().then(() => db.q(`insert into implicari (tip, nume, companie, functie, email, telefon, mesaj, acord, sursa_pagina)
        values ($1, $2, $3, $4, $5, $6, $7, true, $8)`, [rec.tip, rec.nume, rec.companie, rec.functie, rec.email, rec.telefon, rec.mesaj, rec.sursa_pagina])).then(() => true, (e) => { console.error('implicare nesalvată', e.message); return false; });
      if (!ok) return sendJson(res, 503, { error: 'nedisponibil' });
      return sendJson(res, 200, { ok: true });
    }
    // listele cu date personale (aplicări, mesaje de susținere): doar în panoul pornit local, pe calculatorul echipei.
    // Panoul online nu are parolă, deci pe Vercel nu le arată.
    if ((url === '/api/aplicari' || url === '/api/implicari') && req.method === 'GET') {
      if (process.env.VERCEL) return sendJson(res, 403, { error: url === '/api/aplicari' ? 'Aplicările se văd doar în panoul local.' : 'Mesajele se văd doar în panoul local.' });
      if (!db.on()) return sendJson(res, 503, { error: 'Lipsește DATABASE_URL în .env.local (baza Neon).' });
      await db.init();
      const rows = await db.q(url === '/api/aplicari'
        ? `select coalesce(json_agg(a order by a.actualizat desc), '[]')::text as j from aplicari a`
        : `select coalesce(json_agg(i order by i.primit desc), '[]')::text as j from implicari i`).catch(() => null);
      if (!rows) return sendJson(res, 502, { error: 'Nu am putut citi datele din baza de date.' });
      return sendJson(res, 200, rows[0].j);
    }
    // starea CMS-ului pentru panou: dacă se poate edita, textele paginilor, modificările încă nepublicate
    if (url === '/api/cms' && req.method === 'GET') {
      const E = readEditari();
      return sendJson(res, 200, { editabil: !READ_ONLY, pagini: fresh('./site/texte').PAGINI, texte: E.texte, nepublicate: READ_ONLY ? [] : pendingList(), editari: E });
    }
    if (READ_ONLY && req.method !== 'GET') return sendJson(res, 403, { error: 'Pe versiunea publicată panoul e doar pentru vizualizare. Modificările se fac local, apoi git push.' });
    if (url === '/api/brand/activ' && req.method === 'PUT') {
      const { id } = await body(req);
      const brand = fresh('./site/brand'), B = readJson(brand.FILE, {}); // varianta publicată, nu cea de lucru
      if (!B.variante.some((v) => v.id === id)) return sendJson(res, 400, { error: 'variantă inexistentă' });
      B.activ = id;
      writeJson(brand.FILE, B);
      writeBrandLocal();
      await store.flush();
      return sendJson(res, 200, { ok: true, activ: id });
    }
    if (url === '/api/brand/icon' && req.method === 'PUT') {
      const { activ, culori } = await body(req);
      const brand = fresh('./site/brand'), B = readJson(brand.FILE, {}), I = B.icon_meniu;
      if (activ !== undefined && !I.variante.some((v) => v.id === activ)) return sendJson(res, 400, { error: 'icon inexistent' });
      if (culori !== undefined && !I.moduri_culoare.some((m) => m.id === culori)) return sendJson(res, 400, { error: 'mod de culoare inexistent' });
      if (activ !== undefined) I.activ = activ;
      if (culori !== undefined) I.culori = culori;
      writeJson(brand.FILE, B);
      writeBrandLocal();
      await store.flush();
      return sendJson(res, 200, { ok: true, activ: I.activ, culori: I.culori });
    }
    // CMS-ul din panou: modificările se scriu în data/curare/editari.json, apoi entitățile se reconstruiesc
    if (url === '/api/editari' && req.method === 'PUT') {
      const r = cmsEdit(await body(req));
      if (!r.error) await store.flush();
      return sendJson(res, r.error ? 400 : 200, r);
    }
    if (url === '/api/upload' && req.method === 'POST') {
      const { nume, data } = await body(req);
      const m = /^data:image\/(png|jpe?g|webp|svg\+xml);base64,(.+)$/.exec(data || '');
      if (!m) return sendJson(res, 400, { error: 'Fișierul trebuie să fie o imagine (PNG, JPG, WEBP sau SVG).' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 4e6) return sendJson(res, 400, { error: 'Imaginea e prea mare (maxim 4 MB).' });
      const ext = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', 'svg+xml': 'svg' }[m[1]];
      const file = `${script('lib').slug(nume || 'imagine').slice(0, 50) || 'imagine'}-${Date.now().toString(36)}.${ext}`;
      // unde ajunge imaginea: în Vercel Blob (dacă există BLOB_READ_WRITE_TOKEN), altfel în Neon, altfel (local, fără bază) pe disc
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        const url = await blobPut(`uploads/${file}`, buf, TYPES['.' + ext]);
        if (url) return sendJson(res, 200, { url });
        console.error('Blob indisponibil: imaginea rămâne în Neon');
      }
      if (db.on()) {
        await db.init();
        await db.q('insert into imagini (cale, tip, date) values ($1, $2, $3)', [file, TYPES['.' + ext], buf.toString('base64')]);
        return sendJson(res, 200, { url: `/assets/uploads/${file}` });
      }
      const dir = path.join(ROOT, 'site', 'assets', 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), buf);
      return sendJson(res, 200, { url: `/assets/uploads/${file}` });
    }
    // publicarea: modificările alese (sau toate) trec din jurnal în editari.json, apoi pe git; Vercel publică singur
    if (url === '/api/publica' && req.method === 'POST') {
      const { ids } = await body(req).catch(() => ({}));
      const J = readJurnal(), pick = Array.isArray(ids) ? new Set(ids) : null;
      const sel = J.intrari.filter((x) => !pick || pick.has(x.id));
      if (!sel.length) return sendJson(res, 200, { ok: true, mesaj: 'Nimic de publicat.', nepublicate: pendingList() });
      const ED = script('editari'), P = readPublished(), inainte = JSON.parse(JSON.stringify(P));
      const Bp = readJson(BRAND, null), inainteBrand = JSON.parse(JSON.stringify(Bp));
      sel.filter((x) => x.tinta !== 'brand').forEach((x) => ED.patch(P, x.patch));
      const selBrand = sel.filter((x) => x.tinta === 'brand');
      if (selBrand.length) { selBrand.forEach((x) => patchBrand(Bp, x.patch)); writeJson(BRAND, Bp); }
      J.intrari = J.intrari.filter((x) => !sel.includes(x));
      writeJson(EDITARI, { _despre: PUB_NOTE, ...P });
      writeJson(JURNAL, J);
      rebuild();
      const n = new Set(sel.map((x) => x.grup)).size;
      saveVersion(P, { tip: 'publicare', ce: [...new Set(sel.map((x) => x.ce))], inainte, inainteBrand });
      try {
        await store.flush();
        gitPublish(`Panou: ${n === 1 ? 'publicat' : n + ' modificări publicate'}: ${[...new Set(sel.map((x) => x.ce))].slice(0, 6).join('; ')}`);
      } catch (e) { return sendJson(res, 500, { error: 'Publicarea a eșuat: ' + String(e.stderr || e.message).slice(0, 300), nepublicate: pendingList() }); }
      return sendJson(res, 200, { ok: true, mesaj: `${n === 1 ? 'Modificarea a fost publicată' : n + ' modificări publicate'}. ${ONLINE ? 'Apare pe site imediat.' : 'Site-ul se actualizează în ~1 minut.'}`, nepublicate: pendingList() });
    }
    // istoricul publicărilor (pentru pagina Modificări din panou)
    if (url === '/api/istoric' && req.method === 'GET') {
      const H = readIstoric();
      return sendJson(res, 200, { editabil: !READ_ONLY, versiuni: H.versiuni.slice().reverse(), nepublicate: READ_ONLY ? [] : pendingList() });
    }
    // revenirea la o versiune: datele publicate devin cele din versiunea aleasă (modificările nepublicate rămân în jurnal)
    if (url === '/api/restaureaza' && req.method === 'POST') {
      const { versiune } = await body(req).catch(() => ({}));
      const H = readIstoric(), v = H.versiuni.find((x) => x.id === versiune);
      if (!v) return sendJson(res, 404, { error: 'Versiune inexistentă.' });
      await store.preload(path.join(VERSIUNI, v.id + '.json'));
      await store.preload(path.join(VERSIUNI, v.id + '.brand.json'));
      const snap = readJson(path.join(VERSIUNI, v.id + '.json'), null);
      if (!snap) return sendJson(res, 500, { error: 'Copia versiunii lipsește.' });
      const P = readPublished(), snapBrand = readJson(path.join(VERSIUNI, v.id + '.brand.json'), null), Bnow = readJson(BRAND, null);
      if (JSON.stringify(P) === JSON.stringify(snap) && (!snapBrand || JSON.stringify(snapBrand) === JSON.stringify(Bnow))) return sendJson(res, 200, { ok: true, mesaj: 'Site-ul e deja la această versiune.' });
      writeJson(EDITARI, { _despre: PUB_NOTE, ...snap });
      if (snapBrand) writeJson(BRAND, snapBrand);
      rebuild();
      const when = new Date(v.cand).toLocaleString('ro-RO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      saveVersion(snap, { tip: 'revenire', ce: [`Revenire la versiunea din ${when}`], din: v.id });
      try { await store.flush(); gitPublish(`Panou: revenire la versiunea din ${when}`); } catch (e) { return sendJson(res, 500, { error: 'Revenirea a eșuat la publicare: ' + String(e.stderr || e.message).slice(0, 300) }); }
      return sendJson(res, 200, { ok: true, mesaj: `Site-ul a revenit la versiunea din ${when}. ${ONLINE ? 'Apare pe site imediat.' : 'Se actualizează online în ~1 minut.'}` });
    }
    // renunțarea la modificări nepublicate: dispar din jurnal, iar starea locală revine la cea de dinainte
    if (url === '/api/renunta' && req.method === 'POST') {
      const { ids } = await body(req).catch(() => ({}));
      if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: 'Alege modificarea.' });
      const J = readJurnal(), pick = new Set(ids);
      J.intrari = J.intrari.filter((x) => !pick.has(x.id));
      writeJson(JURNAL, J);
      rebuild();
      await store.flush();
      return sendJson(res, 200, { ok: true, nepublicate: pendingList() });
    }
    if (url.startsWith('/api/')) return sendJson(res, 404, { error: 'rută necunoscută' });
    if (url.startsWith('/manage/assets/')) return sendFile(res, safe(path.join(ROOT, 'manage', 'assets'), url.slice('/manage/assets/'.length)) || '');
    if (url === '/manage' || url.startsWith('/manage/')) return sendFile(res, path.join(ROOT, 'manage', 'index.html'));
    if (url === '/assets/brand.css') {
      res.writeHead(200, { 'Content-Type': TYPES['.css'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/brand').css());
    }
    // imaginile încărcate din panou în Neon (cât timp nu există Blob): numele e unic, deci se pot păstra un an
    if (url.startsWith('/assets/uploads/') && db.on() && !fs.existsSync(path.join(ROOT, 'site', url))) {
      const rows = await db.q('select tip, date from imagini where cale = $1', [url.slice('/assets/uploads/'.length)]).catch(() => []);
      if (!rows.length) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': rows[0].tip, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(Buffer.from(rows[0].date, 'base64'));
    }
    if (url.startsWith('/assets/')) return sendFile(res, safe(path.join(ROOT, 'site', 'assets'), url.slice('/assets/'.length)) || '', /(^|&)v=[0-9a-f]{8}(&|$)/.test(query));
    // paginile site-ului se generează la fiecare cerere din data/entitati.json și data/brand.json
    // pagina Teme e ascunsă (site/util.js › TEME): adresele ei duc la /program
    if (!fresh('./site/util').TEME && /^\/teme(\/|$)/.test(url)) { res.writeHead(301, { Location: '/despre' }); return res.end(); }
    // Program e acum parte din Despre: adresa veche (și ancorele ei) duce acolo
    if (url === '/program') { res.writeHead(301, { Location: '/despre' }); return res.end(); }
    const PAGES = { '/': 'renderHome3', '/despre': 'renderDespre', '/teme': 'renderTeme' };
    // adresa veche de contact duce la secțiunea de contact din /despre
    if (url === '/contact') { res.writeHead(301, { Location: '/despre#contact' }); return res.end(); }
    // paginile legale: până au varianta lor pe site, trimit (temporar, 302) la politicile Fundației RBL, operatorul datelor
    const LEGAL = { '/confidentialitate': 'https://www.rbls.ro/politica-de-confidentialitate/', '/termeni-si-conditii': 'https://www.rbls.ro/termeni-si-conditii/', '/politica-cookies': 'https://www.rbls.ro/politica-cookies/' };
    if (LEGAL[url]) { res.writeHead(302, { Location: LEGAL[url] }); return res.end(); }
    // varianta nouă a homepage-ului e acum „/”; cea veche rămâne doar local, pentru comparație
    // homepage-ul de recrutare, în stilul Carbon adaptat la brand, e acum „/” (și stilul e pe tot site-ul): previzualizările lui duc acolo;
    // homepage-ul de dinainte („2029”) rămâne doar local, pentru comparație
    if (url === '/previzualizare/acasa' || url === '/previzualizare/carbon') { res.writeHead(301, { Location: '/' }); return res.end(); }
    if (url === '/previzualizare/acasa-2029' && !READ_ONLY) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderHome({ brand: new URLSearchParams(query).get('brand') || undefined }));
    }
    // Despre nouă e acum /despre; paginile vechi Despre și Program rămân doar local, pentru comparație
    if (url === '/previzualizare/despre') { res.writeHead(301, { Location: '/despre' }); return res.end(); }
    if ((url === '/previzualizare/despre-veche' || url === '/previzualizare/program-vechi') && !READ_ONLY) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render')[url.endsWith('program-vechi') ? 'renderProgram' : 'renderDespreOld']({ brand: new URLSearchParams(query).get('brand') || undefined }));
    }
    if (url === '/previzualizare/acasa-veche' && !READ_ONLY) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderHomeOld({ brand: new URLSearchParams(query).get('brand') || undefined }));
    }
    if (PAGES[url]) {
      const brand = new URLSearchParams(query).get('brand') || undefined;
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render')[PAGES[url]]({ brand }));
    }
    // /aplica (opțional ?editie=cluj-1)
    if (url === '/aplica' || url === '/aplica/') {
      const q = new URLSearchParams(query);
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderAplica({ brand: q.get('brand') || undefined, editie: q.get('editie') || undefined }));
    }
    // /editii/22, /editii/cluj-1
    const ed = /^\/editii\/((?:cluj-)?\d+)\/?$/.exec(url);
    if (ed) {
      const html = fresh('./site/render').renderEdition({ key: ed[1], brand: new URLSearchParams(query).get('brand') || undefined, preview: !READ_ONLY && new URLSearchParams(query).has('previzualizare') });
      if (html) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }); return res.end(html); }
    }
    // /lideri: trainerii, antreprenorii invitați și facilitatorii; /lideri/<id>: fișa fiecăruia
    // adresele vechi /traineri... duc la /lideri...
    const oldTr = /^\/traineri(\/.*)?$/.exec(url);
    if (oldTr) { res.writeHead(301, { Location: '/lideri' + (oldTr[1] && oldTr[1] !== '/' ? oldTr[1] : '') + (query ? '?' + query : '') }); return res.end(); }
    if ((url === '/lideri' || url === '/lideri/')) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderTraineri({ brand: new URLSearchParams(query).get('brand') || undefined }));
    }
    const tr = /^\/lideri\/([a-z0-9-]+)\/?$/.exec(url);
    if (tr) {
      const html = fresh('./site/render').renderTrainer({ id: tr[1], brand: new URLSearchParams(query).get('brand') || undefined });
      if (html) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }); return res.end(html); }
      // un nume scris altfel (alias din data/curare/oameni.json) duce la fișa corectă
      const alias = readJson(path.join(DATA, 'curare', 'oameni.json'), {}).aliasuri?.[tr[1]];
      if (alias) { res.writeHead(301, { Location: `/lideri/${alias}` }); return res.end(); }
    }
    // /editii: lista cohortelor (active sus, arhiva pe ani)
    if ((url === '/editii' || url === '/editii/')) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderEditii({ brand: new URLSearchParams(query).get('brand') || undefined }));
    }
    // /parteneri: partenerii cohortelor, sponsorii atelierelor, implicarea; linkurile vechi din meniu duc la secțiunea lor
    if ((url === '/parteneri' || url === '/parteneri/')) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderParteneri({ brand: new URLSearchParams(query).get('brand') || undefined }));
    }
    const PT = { '/parteneri/sponsorizare': 'sponsorizeaza', '/parteneri/gazda': 'gazduieste', '/parteneri/mentor': 'mentor' };
    if (PT[url]) { res.writeHead(301, { Location: '/parteneri#' + PT[url] }); return res.end(); }
    // /comunitate: toți alumnii (căutare, explorare, director); /comunitate/<id>: doar cu profil completat (previzualizarea pentru ceilalți merge doar local)
    // adresele vechi /alumni... duc la /comunitate...
    if (url === '/alumni/din-alumni-parteneri') { res.writeHead(301, { Location: '/comunitate#din-alumni-parteneri' }); return res.end(); }
    const old = /^\/alumni(\/.*)?$/.exec(url);
    if (old) { res.writeHead(301, { Location: '/comunitate' + (old[1] && old[1] !== '/' ? old[1] : '') + (query ? '?' + query : '') }); return res.end(); }
    // indexul pentru căutarea din meniu (se încarcă doar când cineva caută)
    if (url === '/comunitate.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fresh('./site/render').renderCommunityIndex());
    }
    if ((url === '/comunitate' || url === '/comunitate/')) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      const q1 = new URLSearchParams(query);
      return res.end(fresh('./site/render').renderAlumni({ brand: q1.get('brand') || undefined, sector: q1.get('sector') || undefined, editie: q1.get('editie') || undefined, q: q1.get('q') || undefined }));
    }
    // paginile separate ale comunității: căutarea, industriile, cohortele
    if (fresh('./site/util').CM_PAGES) {
      const q3 = new URLSearchParams(query), R = fresh('./site/render'), brand = q3.get('brand') || undefined;
      let cm = null;
      if (url === '/comunitate/cauta') cm = R.renderCauta({ brand, q: (q3.get('q') || '').trim().slice(0, 120) });
      else if (url === '/comunitate/industrii') cm = R.renderIndustrii({ brand });
      else if (url === '/comunitate/cohorte') cm = R.renderCohorte({ brand });
      else {
        const m = /^\/comunitate\/(industrii|cohorte)\/([a-z0-9-]+)$/.exec(url);
        if (m) cm = m[1] === 'industrii' ? R.renderIndustrie({ brand, id: m[2] }) : R.renderCohortaCm({ brand, id: m[2] });
      }
      if (cm) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }); return res.end(cm); }
    }
    const al = AL_RE.exec(url);
    if (al) {
      const q2 = new URLSearchParams(query);
      const html = fresh('./site/render').renderAlumnus({ id: al[1], brand: q2.get('brand') || undefined, preview: !READ_ONLY && q2.has('previzualizare') });
      if (html) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }); return res.end(html); }
    }
    // /teme/vanzari: pagină pentru temele full-day; cele de seară duc la secțiunea lor din /teme
    const tm = /^\/teme\/([a-z0-9-]+)\/?$/.exec(url);
    if (tm) {
      const r = fresh('./site/render').renderTema({ id: tm[1], brand: new URLSearchParams(query).get('brand') || undefined });
      if (r?.redirect) { res.writeHead(301, { Location: r.redirect }); return res.end(); }
      if (r?.html) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }); return res.end(r.html); }
    }
    // adresele de API primesc JSON; paginile, o pagină 404 cu meniu și footer
    if (url.startsWith('/api/')) return sendJson(res, 404, { error: 'pagină inexistentă' });
    res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return res.end(fresh('./site/render').render404({ brand: new URLSearchParams(query).get('brand') || undefined }));
  } catch (e) {
    // dacă răspunsul a apucat să înceapă, nu mai putem trimite antetele unei erori: doar îl închidem
    if (res.headersSent) { console.error(e); return res.end(); }
    sendJson(res, 500, { error: e.message });
  }
}

module.exports = handler;

// local: node server.js pornește serverul; pe Vercel (presetul Node), server.js rulează ca funcție și primește toate cererile
if (require.main === module) {
  // doar pe calculatorul acesta (127.0.0.1): panoul și listele de aplicări nu trebuie să fie vizibile altora din aceeași rețea
  http.createServer(handler).listen(PORT, '127.0.0.1', () => {
    console.log(`Antreprenoria – site:   http://localhost:${PORT}/`);
    console.log(`Antreprenoria – panou:  http://localhost:${PORT}/manage`);
  });
}
