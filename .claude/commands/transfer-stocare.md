---
description: Mută stocarea antreprenoria.ro în contul vostru Vercel (Neon + Blob), după transferul proiectului de la DWF
---

Ești în repo-ul `antreprenoria` (site + panou /manage, Node fără dependențe). DWF a transferat repo-ul și proiectul Vercel `antreprenoria`. Scopul: proiectul să folosească doar baza Neon și Blob-ul din echipa Vercel a clientului, cu toate datele copiate, fără să piardă nimic. Contextul complet e în `docs/transfer-client.md` și în README („Vercel, Neon și Blob”).

Reguli:
- Vorbește în română, pe scurt, și spune la fiecare pas ce faci.
- Nu afișa niciodată tokenuri, parole sau `DATABASE_URL` în răspunsuri; maschează-le.
- Nu șterge și nu modifica resursele DWF (baza veche, Blob-ul vechi). Doar citești din ele.
- Datele din Neon conțin date personale (aplicări). Copiile temporare stau în directorul temporar al sistemului și se șterg la final.
- Înainte de orice pas care creează resurse sau republică site-ul, spune ce urmează și cere confirmarea.

Pași:

1. **Verifică mediul.** `node --version` (trebuie 24+), `git remote -v`, `npx vercel whoami`, apoi `npx vercel link` pe proiectul `antreprenoria` din echipa clientului. Verifică în Settings → Git (sau cu `npx vercel project inspect antreprenoria`) că proiectul e legat de repo-ul clientului, ramura `main`.

2. **Vezi ce are proiectul.** `npx vercel env ls` și `npx vercel integration list`.
   - Dacă resursa Neon `antreprenoria-db` apare în echipa clientului (s-a mutat cu linkul de claim), Neon e gata: treci la pasul 4.
   - Dacă `DATABASE_URL` arată încă spre baza DWF (resursa Neon nu e în echipa clientului), continuă cu pasul 3.

3. **Neon nou (doar dacă e nevoie).**
   - Salvează adresa bazei vechi: `npx vercel env pull .env.vechi --environment=production --yes` și citește din el `DATABASE_URL_UNPOOLED` (sau cere-o utilizatorului).
   - Scoate din proiect variabilele Neon vechi (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_*`, `PG*`, `NEON_*`, `VITE_NEON_AUTH_URL`) cu `npx vercel env rm <nume> <mediu> --yes`.
   - Creează baza: `npx vercel integration add neon --name antreprenoria-db --meta region=fra1 -e production -e preview -e development`, apoi `npx vercel env pull .env.local`.
   - Copiază tabelele `fisiere`, `imagini`, `aplicari`, `implicari` din baza veche în cea nouă. Dacă există `pg_dump`/`psql`: `pg_dump --no-owner --no-acl -t fisiere -t imagini -t aplicari -t implicari "<veche>" | psql "<nouă>"`. Altfel, scrie un script Node temporar care folosește `site/db.js` (API-ul HTTP Neon) pentru ambele baze și copiază rândurile pe tabel, în loturi, păstrând `id`, `token` și datele; la final reglează secvențele (`select setval(pg_get_serial_sequence('aplicari','id'), max(id)) from aplicari`, la fel pentru `implicari`).
   - Verifică: același număr de rânduri în fiecare tabel, în ambele baze.

4. **Blob.** Dacă proiectul are `BLOB_READ_WRITE_TOKEN` de la DWF (vezi `/api/stare`: `încă depozitul DWF`), cere ștergerea lui din proiect. Creează Blob-ul clientului: `npx vercel blob create-store antreprenoria-media --region fra1 --access public` legat de proiect (sau din Storage → Create → Blob, public, Frankfurt, cu toate mediile bifate). Apoi `npx vercel env pull .env.local` și `npm run blob:copy`. Scriptul mută imaginile încărcate din panou (din Neon și, dacă există `DWF_BLOB_TOKEN`, din Blob-ul DWF) și rescrie adresele în datele panoului. Trebuie să se termine cu „Gata”.

5. **Publică și verifică.** Scoate `DWF_BLOB_TOKEN` dacă există, apoi republică: `npx vercel --prod` (sau Redeploy din Vercel). Verifică:
   - `https://<adresa-proiectului>/api/stare` arată `"neon":true` și `"blob":"BLOB_READ_WRITE_TOKEN"`;
   - `/`, `/despre`, `/comunitate`, `/aplica` și `/manage` răspund 200;
   - `/api/cms` arată `"editabil":true` și aceleași modificări nepublicate ca înainte;
   - rulează încă o dată `npm run blob:copy`, ca să prindă ce s-a încărcat între timp.

6. **Curățenie.** Șterge `.env.vechi` și orice fișier temporar cu credențiale sau date. `.env.local` poate rămâne (e ignorat de git).

7. **Mesajul pentru DWF.** Scrie un mesaj scurt, gata de trimis: proiectul folosește acum Neon-ul și Blob-ul clientului, câte rânduri și fișiere s-au copiat, rezultatul `/api/stare`, și că DWF își poate șterge resursele vechi (vezi „După confirmarea clientului” în `docs/transfer-client.md`).
