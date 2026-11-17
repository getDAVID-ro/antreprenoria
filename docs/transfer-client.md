# Transferul antreprenoria.ro către client

> Pregătit pe 17.11.2026, după modelul boxe-depozitare.ro. Repo-ul trece la client prin transferul de pe GitHub, iar proiectul Vercel printr-un link de claim, care mută odată cu proiectul și baza Neon. Blob-ul nu se mută: clientul își face Blob-ul lui și mută în el imaginile încărcate din panou cu `npm run blob:copy`.

## Ce există acum, la DWF

| Resursă | Unde | Detalii |
|---|---|---|
| Repo | GitHub `getDAVID-ro/antreprenoria` (public) | ramura de producție `main`; până la 17.11.2026 a fost `toma776/antreprenoria` (GitHub redirecționează adresa veche) |
| Proiect Vercel | echipa `dwf3`, proiectul `antreprenoria` (`prj_kJxWpz8oEndbtsXUKnvkBP03aZ4b`) | producție: https://antreprenoria-dwf3.vercel.app; legat de GitHub (`main` publică singur); funcția rulează în `fra1` |
| Baza de date | Neon `antreprenoria-db`, prin Vercel Marketplace (resursa `store_JlAyMTXtiUTr9GTB`, proiectul Neon `long-mud-31068889`) | Frankfurt (`aws eu-central-1`), planul Free; variabilele `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_*`, `PG*`, `NEON_*` pe toate mediile |
| Fișiere | **niciun Blob** la DWF | echipa `dwf3` a atins limita de depozite Blob. Imaginile site-ului sunt în git; cele încărcate din panou stau în Neon (tabelul `imagini`) până există `BLOB_READ_WRITE_TOKEN` |

Ce ține Neon (tabelele se creează singure, `site/db.js`):
- `fisiere`: modificările din panou (publicate și nepublicate), istoricul cu versiunile, brandul. Ce nu e încă aici se citește din git.
- `aplicari`: aplicările de pe `/aplica`, în pași (cu tokenul de reluare).
- `implicari`: mesajele din formularul „Susține programul” de pe `/parteneri`.
- `imagini`: imaginile încărcate din panou, cât timp proiectul n-are Blob.

Supabase (proiectul `gqhjaagqwizauzxhnbwi`) nu se mai folosește. Era în pauză din octombrie 2026; aplicările vechi din el nu au fost mutate.

**De ce contează ordinea.** Neon se mută cu proiectul, deci datele panoului și aplicările ajung la client. Imaginile din Neon trebuie mutate în Blob-ul clientului cu `npm run blob:copy`, care le rescrie și adresele. Dacă proiectul primește între timp un Blob DWF, tokenul lui se copiază și în `DWF_BLOB_TOKEN`, iar scriptul îl citește de acolo, ca la boxe-depozitare.ro.

## Ordinea transferului

### Înainte (o dată)

1. Clientul are:
   - un cont sau o organizație GitHub;
   - un cont Vercel;
   - pe calculator: Node.js 24 și Git.
2. DWF își păstrează o copie a credențialelor, pentru orice eventualitate:
   ```bash
   npx vercel env pull .env.transfer-dwf --environment=production --yes
   ```
   Fișierul stă în rădăcina repo-ului, unde `.env*` e ignorat de git, și nu se trimite pe email.
3. Dacă vreți o copie a datelor înainte de transfer: `pg_dump "$DATABASE_URL_UNPOOLED" > antreprenoria-neon.sql` (conține date personale: nu se trimite pe email, se șterge după confirmare).

### Transferul (DWF)

1. **GitHub:** repo → Settings → Danger Zone → **Transfer ownership** → contul clientului (trebuie să fiți admin în `getDAVID-ro`). Alternativ:
   ```bash
   gh api -X POST repos/getDAVID-ro/antreprenoria/transfer -f new_owner=<cont-client>
   ```
2. **Vercel, cu link de claim.** Linkul e valabil 24 de ore, iar cine îl are poate lua proiectul: îl trimiteți doar clientului. Codul se generează din rădăcina repo-ului:
   ```bash
   npx vercel api /projects/antreprenoria/transfer-request?teamId=dwf3 -X POST --input - <<< '{}'
   ```
   Linkul:
   ```
   https://vercel.com/claim-deployment?code=<code>&returnUrl=https%3A%2F%2Fantreprenoria-dwf3.vercel.app
   ```
   - Clientul îl deschide, intră în contul lui Vercel, alege echipa și apasă **Transfer**.
   - Odată cu proiectul se mută și baza Neon `antreprenoria-db`; variabilele de mediu vin și ele.
   - Adresa `antreprenoria-dwf3.vercel.app` conține numele echipei DWF: la client, proiectul primește o adresă nouă `*.vercel.app`. `antreprenoria.vercel.app` rămâne a proiectului.
   - Dacă linkul expiră, generați altul cu aceeași comandă.
   - Alternativa fără link: Settings → General → **Transfer Project**. Atunci Neon nu se mută, iar clientul rulează `/transfer-stocare` (mai jos).
3. **Domeniul:** la 17.11.2026 proiectul are doar adrese `*.vercel.app`, iar site-ul are `noindex` pe toate paginile (`vercel.json`). La lansare pe antreprenoria.ro, domeniul se adaugă în echipa clientului și se scoate `noindex`.

### Mesajul pentru client (gata de trimis)

Linkul de claim se trimite separat, înainte. În mesaj, `<cont-github>` devine contul clientului (pașii sunt și în README, la „Mutarea imaginilor în Blob-ul vostru”):

> 1. În proiectul de pe Vercel: Storage → Create → Blob, public, Frankfurt, legat de proiect. Dacă proiectul are deja variabila `BLOB_READ_WRITE_TOKEN`, ștergeți-o întâi: e de la depozitul DWF.
> 2. Cu Node 24 sau mai nou: `git clone https://github.com/<cont-github>/antreprenoria.git`, apoi `cd antreprenoria`, apoi `npx vercel link` (alegeți proiectul `antreprenoria`), apoi `npx vercel env pull .env.local`, apoi `npm run blob:copy`. Copierea durează câteva minute și la final confirmă fiecare fișier.
> 3. Dacă există variabila `DWF_BLOB_TOKEN`, ștergeți-o din Settings → Environment Variables. Apoi faceți Redeploy.
> 4. Rulați încă o dată `npm run blob:copy`, ca să prindă ce s-a încărcat între timp.
>
> Verificare: `https://<adresa-proiectului>/api/stare` trebuie să arate `"neon":true` și `"blob":"BLOB_READ_WRITE_TOKEN"`. Pașii sunt și în README, la „Mutarea imaginilor în Blob-ul vostru”. În Claude Code, comanda `/transfer-stocare` din repo face aceiași pași.

`/api/stare` arată `neon` (dacă proiectul are `DATABASE_URL`), `blob` (ce token ar folosi panoul la încărcare: niciunul, `BLOB_READ_WRITE_TOKEN (încă depozitul DWF)` sau `BLOB_READ_WRITE_TOKEN`), câte imagini mai sunt în Neon și regiunea funcției. Nu afișează niciun token.

După transfer, Settings → Git din proiectul clientului trebuie să arate repo-ul lui (`<cont-github>/antreprenoria`, ramura `main`); dacă nu, îl leagă cu Connect Git Repository.

### Varianta cu Claude Code: `/transfer-stocare`

Pentru transferul fără link de claim (Neon rămâne la DWF) sau dacă clientul preferă să fie ghidat. În rădăcina repo-ului, în Claude Code: `/transfer-stocare` (`.claude/commands/transfer-stocare.md`). Comanda:
1. verifică echipa, proiectul și legătura cu GitHub;
2. dacă proiectul n-are Neon al clientului: citește adresa bazei vechi (o cere), creează în echipa clientului Neon `antreprenoria-db` în Frankfurt, conectat la proiect, și copiază tabelele;
3. creează Blob-ul clientului și rulează `npm run blob:copy`;
4. publică site-ul și verifică `/api/stare`, paginile și panoul;
5. șterge fișierele temporare cu credențiale;
6. dă mesajul de trimis la DWF.

Resursele vechi nu le atinge.

### După confirmarea clientului (DWF)

```bash
npx vercel switch dwf3
```

- Neon: dacă s-a mutat cu linkul de claim, nu mai apare în `npx vercel integration list --all`. Dacă a rămas în `dwf3`: `npx vercel integration resource delete antreprenoria-db --disconnect-all`.
- Integrarea Neon din echipa `dwf3` rămâne: o folosesc și alte proiecte.
- Dacă între timp s-a creat un Blob DWF pentru proiect: `npx vercel blob delete-store <store_id>` (dacă refuză, întâi Storage → depozit → Projects → Disconnect).
- Supabase: proiectul `gqhjaagqwizauzxhnbwi` se poate șterge după ce decideți ce faceți cu aplicările vechi din el.
- DWF șterge copiile locale `.env.transfer-dwf`, `.env.local` și eventualul `antreprenoria-neon.sql`.
