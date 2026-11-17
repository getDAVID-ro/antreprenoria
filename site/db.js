// Baza de date Neon (Postgres), prin API-ul HTTP al Neon: fără pachete, doar fetch.
// Adresa vine din DATABASE_URL (pusă de integrarea Neon din Vercel; local, în .env.local).
// Fără DATABASE_URL, site-ul și panoul merg pe fișierele din data/ (ca înainte), iar formularele răspund „nedisponibil”.
const url = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const on = () => !!url();
// ep-xxx-pooler.<regiune>.aws.neon.tech -> api.<regiune>.aws.neon.tech/sql
const endpoint = () => 'https://' + new URL(url()).hostname.replace(/^[^.]+\./, 'api.') + '/sql';

async function call(payload, extra = {}) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Neon-Connection-String': url(), 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15e3),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error('Neon: ' + ((j && j.message) || r.status));
  return j;
}
// o interogare: rândurile, cu valorile ca text (pentru JSON folosim ::text și JSON.parse)
const q = async (query, params = []) => (await call({ query, params })).rows;
// mai multe interogări într-o singură tranzacție
const tx = async (list) => (await call({ queries: list }, { 'Neon-Batch-Isolation-Level': 'ReadCommitted', 'Neon-Batch-Read-Only': 'false' })).results.map((x) => x.rows);

// tabelele se creează singure la prima folosire (și într-o bază nouă, după transfer)
const SCHEMA = [
  // fișierele panoului (publicat, nepublicat, istoric, versiuni, brand); continut null = fișier șters
  `create table if not exists fisiere (cale text primary key, continut text, actualizat timestamptz not null default now())`,
  // imaginile încărcate din panou, cât timp nu există Blob (BLOB_READ_WRITE_TOKEN)
  `create table if not exists imagini (cale text primary key, tip text not null, date text not null, creat timestamptz not null default now())`,
  // aplicările de pe /aplica, în pași (pasul 1 = contactul); tokenul reia aplicarea neterminată
  `create table if not exists aplicari (
    id bigserial primary key, primit timestamptz not null default now(), actualizat timestamptz not null default now(),
    token uuid not null unique default gen_random_uuid(), pas int not null default 1, finalizata boolean not null default false,
    stare text not null default 'incompletă' check (stare in ('incompletă','nouă','contactat','acceptat','respins')),
    nume text, email text, telefon text, companie text, cui text, cifra_afaceri text, editie text, sursa text, sursa_alta text,
    acord boolean not null default true, sursa_pagina text,
    raspunsuri jsonb not null default '{}'::jsonb check (pg_column_size(raspunsuri) <= 20000))`,
  // formularul „Susține programul” de pe /parteneri
  `create table if not exists implicari (
    id bigserial primary key, primit timestamptz not null default now(),
    tip text not null check (tip in ('sponsorizare','gazduire','mentorat','cerere-sponsorizare')),
    nume text not null, companie text, functie text, email text not null, telefon text, mesaj text,
    acord boolean not null default true, sursa_pagina text)`,
];
let ready = null;
const init = () => (ready ||= tx(SCHEMA.map((query) => ({ query, params: [] }))).catch((e) => { ready = null; throw e; }));

module.exports = { on, q, tx, init };
