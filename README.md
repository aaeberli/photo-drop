# photo-drop

A static site on GitHub Pages. You hand one link to everybody; they open it on
their phone and land straight on upload buttons, no sign-in step. Originals go
to a private Google Photos album only you can see, full resolution with their
EXIF intact. A second, owner-only link shows the album as a mosaic collage that
reshuffles every minute.

```
                     ┌─ display copy (1920px WebP) ─→ Supabase Storage ─→ collage
 phone ─ #k=key ─────┤
   github.io         └─ original (untouched)      ─→ staged ─→ Google Photos album
                                                                 (then staging deleted)
```

## This deployment

| | |
|---|---|
| Supabase project ref | `dqpxdrvjomtxpdmbrlxi` |
| Functions base URL | `https://dqpxdrvjomtxpdmbrlxi.supabase.co/functions/v1` |
| Pages origin | `https://aaeberli.github.io` |
| Pages site | `https://aaeberli.github.io/photo-drop` |
| Repo | `aaeberli/photo-drop` (public) |
| Google Photos album | `Photo Drop` |
| Google OAuth publishing status | Testing + test user — see [Google Photos](#google-photos-and-the-verification-wall) |

None of those are secrets. The project ref is in `config.js` on the public site
by design; security rests entirely on the access key in the link.

---

## Two links, different powers

| | Link | Scope | Can |
|---|---|---|---|
| Guests | `/#k=…` | `upload` | Add photos. **Cannot open the collage.** |
| You | `/collage.html#k=…` | `view` | Watch the collage. **Cannot upload.** |

The split matters because the guest link goes to everybody, and from there into
group chats. Upload-only means a guest who forwards it cannot show a stranger
the whole album — the worst they can do is add a photo.

`scripts/make-key.mjs` mints both.

## How auth works, and why

Each link carries a 160-bit access key in the URL **fragment**:

```
https://aaeberli.github.io/photo-drop/#k=A7K3M-QP2XV-…
```

A fragment is never transmitted to a server, so the key stays out of access
logs, CDN logs, `Referer` headers and analytics — all places a `?key=…`
querystring would end up. The page reads it on load, POSTs it to `/auth`, and
scrubs it from the address bar with `history.replaceState`. **No taps, no
prompts**: a guest sees the upload buttons about as fast as the page paints.

`/auth` looks the key up by `sha256(key ‖ AUTH_KEY_PEPPER)` — the plaintext is
never stored, and the pepper lives in an edge function secret, so a leaked
database dump gives an attacker nothing to grind against offline. Failures are
rate limited to 10 per IP per 10 minutes; successes are not, so a room full of
guests behind one NAT cannot lock itself out.

In exchange the page gets a **bearer token**, not a cookie. This is forced by
the hosting split: the page is on `github.io` and the API on `supabase.co`, so
any cookie the API set would be a third-party cookie, blocked by default in
Safari and Firefox. And `github.io` is on the Public Suffix List, so there is no
shared parent domain to fall back on. The token is an HS256 JWT signed with a
secret that is deliberately *not* the project's Supabase JWT secret, and carries
no `role` claim — otherwise it would double as a credential against the Supabase
REST API.

Giving up HttpOnly's XSS protection is the one real cost, so the pages
compensate with a strict `Content-Security-Policy`: `script-src 'self'`, no
third-party scripts anywhere. **If you later add an analytics snippet or a font
CDN, you are widening the only hole in this design.**

**The key goes in `localStorage`, the token in `sessionStorage`.** Phones evict
background tabs aggressively; a guest who reopens the page from their tab list
an hour later would otherwise hit a dead end with no way back. The key
persisting means they land on the upload buttons again. The stored key is
namespaced per link role, so your collage link and the guest link can both be
open in one browser without overwriting each other.

## Where the bytes go

Each upload produces two files, and the browser makes the second one:

**Original** — untouched, full resolution, full EXIF. Staged in a private
Storage bucket purely as a retry buffer, mirrored to the Google Photos album,
then the staged copy is deleted and `photos.original_path` set to null. After
that the original exists only in your album.

**Display copy** — re-encoded in the browser, capped at 1920px on the long edge,
WebP q0.80 (JPEG fallback if the browser cannot encode WebP). Permanent, and the
only thing the collage renders. Typically 80–350 KB.

Resizing happens on the phone because Supabase edge functions run on Deno with
no native image library — server-side would mean shipping a WASM decoder, and
none of the practical ones handle HEIC, which is exactly what an iPhone hands
you. The phone already has decoders for whatever its own camera produces.

Two useful side effects of going through a canvas: EXIF orientation is baked
into the pixels, so a photo shot sideways is upright in the collage without the
renderer knowing anything about it; and all metadata is dropped, so **the copy
living in Supabase carries no GPS**. Only the Google Photos original does.

### Why the collage does not read Google Photos

It could, and an earlier cut of this did. Reading that API is worse in every way:

| | Reading Google Photos | Reading Storage (chosen) |
|---|---|---|
| Scopes needed | `appendonly` + `readonly.appcreateddata` | `appendonly` only |
| URL lifetime | `baseUrl` dies after 60 min | 7-day signed URL, cached and reused |
| Browser caching | Defeated — URLs rotate | Works — same URL every poll |
| Photo appears | After the Google mirror succeeds | Seconds after upload |
| Google token lapses | Collage down | Collage fine, mirror falls behind |

The caching row bites hardest in practice. A collage left running on a screen
reshuffles 1,440 times a day; with rotating URLs every tile is a fresh download
and you burn gigabytes of egress. With stable URLs each photo is fetched once.

So Google Photos here is **write-only**: the app requests no read scope at all,
which also means a leaked token cannot enumerate your album.

## Storage and the free tier

Supabase free gives **1 GB file storage** and **5 GB egress per month**.

Measured on this project, from a 4032×3024 (12 MP) source:

| content | source JPEG | JPEG 2560 q82 | JPEG 1920 q78 | **WebP 1920 q78** |
|---|---|---|---|---|
| smooth — sky, portrait | 1244 KB | 166 KB | 57 KB | **16 KB** |
| typical scene | 1619 KB | 264 KB | 134 KB | **42 KB** |
| busy — foliage, a crowd | 3246 KB | 660 KB | 352 KB | **233 KB** |

Two conclusions drove the defaults. **WebP, not JPEG**: at matched visual
quality it is ~35% smaller on the hardest content and several times smaller on
smooth content, at no quality cost. **1920, not 2560**: after the format,
`maxEdge` dominates — 2560→1920 is a ~40% saving — and 1920 is not a compromise,
because the largest mosaic tile spans 2 of 4 columns and is therefore exactly
1920 CSS px wide on a 3840px 4K display. Only a high-dpr desktop monitor at desk
distance wants more.

Those test images are synthetic and compress better than real photographs. Trust
the ratios between columns; for real photos budget **80–350 KB, averaging
~250 KB**, so 1 GB holds roughly **4,000 photos**.

**Egress is the constraint that bites first.** One cold load of a 500-photo
collage costs ~125 MB, so about 40 cold loads a month. "Cold" means a browser
that has not cached the photos — because `/photos` returns the same signed URL
on every poll and objects are served with `max-age=604800`, a collage left
running all day fetches each photo once, and reopening it in the same browser
costs nothing. Several screens, or a device that clears its cache, multiplies it.

`upload-url` refuses new uploads once stored display data passes
`DISPLAY_BUDGET_BYTES` (default 800 MB, leaving headroom under the 1 GB cap for
originals in transit). Guests see "The album is full. Ask the organiser to make
room." rather than a broken upload. Check where you stand:

```sql
select * from storage_usage();
```

### The 7-day pause

Free projects pause after 7 consecutive days without database activity, which
breaks both links until you unpause manually. The `pg_cron` job in setup step 5
runs every minute and calls an edge function that queries the database, so it
keeps the project alive as a side effect — 43,200 invocations a month, well
inside the free 500,000. **If you remove that cron job, expect the project to
pause.**

---

# Setup

Everything here is idempotent. Re-running any step is safe: the SQL uses
`create … if not exists` / `create or replace` / `on conflict`, `secrets set` is
an upsert, and `functions deploy` replaces in place.

## 0. Tooling and account

```bash
npm install -g supabase
```

Supabase's own docs prefer Scoop or a project devDependency via `npx`, but the
npm global install works on Windows — that is what this project was set up with
(v2.116.0).

```bash
supabase login
```

**If you have more than one Supabase account**, the CLI login is browser-driven
and will silently grab whichever identity the browser is signed into. A personal
access token from <https://supabase.com/dashboard/account/tokens> is
deterministic:

```bash
supabase login --token sbp_xxxxxxxx
```

That replaces the stored account. To keep two usable side by side, set
`SUPABASE_ACCESS_TOKEN` per shell instead — it overrides the stored credential
without destroying it, but only inside that shell.

Always confirm which account you are on before anything else:

```bash
supabase projects list
```

## 1. Create and link the project

**Create the project in the dashboard first.** `link` attaches to an existing
project; it does not create one. The free plan allows **2 active projects per
organisation**, so if you already have two, pause one or create the project
under a different account.

```bash
supabase link --project-ref dqpxdrvjomtxpdmbrlxi
```

If this fails with *"Your account does not have the necessary privileges to
access this endpoint"*, the ref is not in an organisation your logged-in account
belongs to. The API returns 403 rather than 404 so it does not leak whether the
project exists. `supabase projects list` shows what you can actually reach; if
the project is missing, you are logged in as the wrong identity.

## 2. Apply the schema

`supabase db push` needs a direct Postgres connection, which many corporate
networks block. If it works, use it:

```bash
supabase db push
```

**If it fails with `Connection terminated unexpectedly`, the network is the
cause, not your password.** Firewalls commonly answer the TCP handshake on
5432/6543 themselves — so the port looks open — then refuse to pass the Postgres
protocol. The tell is that the server never replies to a Postgres `SSLRequest`,
before any credential is sent. `--skip-pooler` does not help: direct connections
(`db.<ref>.supabase.co`) are IPv6-only unless you buy the IPv4 add-on, and fail
with an address-family error instead.

Only `db push` needs Postgres. `link`, `secrets set` and `functions deploy` all
go over `api.supabase.com:443`. So apply the schema in the dashboard SQL editor
instead, from `supabase/sql/`, in order:

| script | contents |
|---|---|
| `01_tables.sql` | 5 tables, indexes, RLS enabled, seeds `sync_state` |
| `02_buckets.sql` | `uploads` + `display` buckets, both private |
| `03_functions.sql` | `claim_pending_photos`, `storage_usage`, `prune_auth_attempts` |
| `04_uploader_link.sql` | `photos.uploaded_by_key` → `access_keys` FK |
| `99_verify.sql` | read-only check |

`03` needs `01` first. `04` is only needed if `01` ran before that column
existed; a fresh `01` includes it. If `02` errors on permissions, create the two
buckets by hand in Storage → New bucket, both with "Public bucket" **off**.

`99_verify.sql` should return 5 tables all `rls_enabled = true`, 2 buckets both
`public = false`, 3 functions, 1 `sync_state` row.

Two notes if you applied by hand:

- The schema deliberately does **not** `create extension pgcrypto`.
  `gen_random_uuid()` has been core Postgres since 13, and `create extension` is
  exactly the kind of statement that fails on permissions in the SQL editor.
- The migration history table lives in a schema that `db push` creates on its
  first successful run. On a project that has never been pushed to, inserting a
  history row fails with `relation "supabase_migrations.schema_migrations" does
  not exist`. You can skip that bookkeeping — the migration is idempotent, so a
  later `db push` re-applies it as a no-op. To record it anyway:

  ```sql
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text not null primary key
  );
  alter table supabase_migrations.schema_migrations
    add column if not exists statements text[];
  alter table supabase_migrations.schema_migrations
    add column if not exists name text;

  insert into supabase_migrations.schema_migrations (version, name)
  values ('20260830120000', 'init')
  on conflict (version) do nothing;
  ```

## 3. Secrets

```bash
cp .env.example .env
```

Generate the four secrets. **`SETUP_SECRET` must be hex** — it travels in a
querystring, where base64's `+` decodes to a space and the comparison silently
fails with "unauthorised":

```bash
for k in SESSION_JWT_SECRET AUTH_KEY_PEPPER CRON_SECRET; do sed -i "s|^${k}=.*|${k}=$(openssl rand -base64 32)|" .env; done
```

```bash
sed -i "s|^SETUP_SECRET=.*|SETUP_SECRET=$(openssl rand -hex 32)|" .env
```

Set `ALLOWED_ORIGINS` to your Pages **origin** — scheme and host only, no path,
no trailing slash. Browsers send the origin, not the page URL:

```bash
sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://aaeberli.github.io|" .env
```

Check nothing is still blank, then push. **A blank value is pushed as an empty
string, not skipped** — and an empty required secret kills the worker at boot
with an opaque `WORKER_ERROR`, because `requireEnv` runs at module scope:

```bash
grep -c '=$' .env
```

Zero, then:

```bash
supabase secrets set --env-file .env
```

`secrets set` is an **upsert**: names in the file are overwritten, names not in
the file are left alone. Removing one needs `supabase secrets unset NAME`. The
`SUPABASE_*` entries are platform-managed and reserved — `.env` must not contain
them.

To spot an accidentally-empty secret later, run `supabase secrets list` and look
for this digest, which is SHA-256 of the empty string:

```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## 4. Deploy the functions

```bash
supabase functions deploy auth upload-url commit photos sync-to-google google-oauth-start google-oauth-callback
```

All seven are deployed with `verify_jwt = false` (see `supabase/config.toml`),
because each authenticates itself — Supabase's gateway check would reject our
own bearer tokens and Google's redirect, which carries no `Authorization` header
at all.

Check what is live and at which version:

```bash
supabase functions list
```

## 5. Cron

Copy `supabase/migrations/20260830120100_cron.sql.template`, replace
`__PROJECT_REF__` with `dqpxdrvjomtxpdmbrlxi` and `__CRON_SECRET__` with your
value, and run it in the SQL editor. Safe to re-run — it unschedules first.

`/commit` also kicks `sync-to-google` directly, so originals normally reach the
album within seconds; cron is the retry net, and the thing that keeps the free
project from pausing.

```sql
select jobname, schedule, active from cron.job;
select jobname, status, start_time, return_message
  from cron.job_run_details order by start_time desc limit 20;
```

## 6. Google Cloud

Do all of this **signed in as the Google account whose Photos library should own
the album** — check the top-right avatar. Wrong account here means redoing
everything from step 3 of this list.

The console was reorganised: "OAuth consent screen" is now **APIs & Services →
Google Auth Platform**, split into Branding, Audience, Data Access and Clients.
Scopes live under Data Access.

| # | Step | Direct link |
|---|---|---|
| 1 | Create project | [projectcreate](https://console.cloud.google.com/projectcreate) |
| 2 | Enable **Google Photos Library API** | [apis/library/photoslibrary.googleapis.com](https://console.cloud.google.com/apis/library/photoslibrary.googleapis.com) |
| 3 | Auth Platform → Get started | [/auth/overview](https://console.cloud.google.com/auth/overview) |
| 4 | Audience → publishing status + test users | [/auth/audience](https://console.cloud.google.com/auth/audience) |
| 5 | Data Access → add the one scope | [/auth/scopes](https://console.cloud.google.com/auth/scopes) |
| 6 | Clients → Create client | [/auth/clients](https://console.cloud.google.com/auth/clients) |

Step 2 is listed as "**Google** Photos Library API" — searching "Photos Library
API" may not surface it. Do **not** enable *Google Photos Picker API* instead;
most current articles point there because it is Google's replacement for
browsing a library, but it cannot write to an album.

Step 3 values: app name, support email, Audience **External**, contact email.

Step 5, paste exactly this and nothing else:

```
https://www.googleapis.com/auth/photoslibrary.appendonly
```

Step 6: Application type **Web application**, one authorised redirect URI,
exactly:

```
https://dqpxdrvjomtxpdmbrlxi.supabase.co/functions/v1/google-oauth-callback
```

No trailing slash and no query string. Google's rules explicitly prohibit a
*fragment*; query strings are not clearly documented either way, which is why
the callback is its own function rather than `?action=callback` on a shared one.

Copy the Client ID and Secret into `.env`, then re-run `supabase secrets set
--env-file .env` and redeploy the two OAuth functions.

### Google Photos and the verification wall

Google's Photos authorization docs state plainly: *"If your application accesses
the Google Photos APIs, it must pass the OAuth verification review."* Publishing
to Production unverified is **not** enough here — you get a hard
`Access blocked: … has not completed the Google verification process`, with no
*Advanced → proceed* bypass.

The route that works without a review queue: **publishing status Testing, with
your own Google account added as a Test user** (step 4 above). Test users get a
warning screen with an **Advanced → Go to photo-drop (unsafe)** bypass.

The cost is documented and specific: *"a project with an OAuth consent screen
configured for an external user type and a publishing status of 'Testing' is
issued a refresh token expiring in 7 days"*. It keys on publishing status, not
verification. So:

- **A one-off event over a weekend** — the token outlives it. Non-issue.
- **Ongoing use** — `sync-to-google` starts failing with `invalid_grant` after a
  week. Uploads and the collage keep working and guests notice nothing, but
  originals stop reaching the album and queue in the `uploads` bucket. Re-open
  the `google-oauth-start` URL to fix. Nothing is lost: `claim_pending_photos`
  retries anything still holding an `original_path`.

To escape the weekly click you must complete verification (3–5 business days for
sensitive scopes), which needs domain ownership of your homepage verified in
Google Search Console, and a privacy policy at its own URL with real content.

### Link the account

```
https://dqpxdrvjomtxpdmbrlxi.supabase.co/functions/v1/google-oauth-start?setup_secret=<SETUP_SECRET>
```

Open it and let Google redirect you. **Do not reload the callback URL** — the
authorization code is single-use and the state is time-limited, so replaying it
always fails. If you see "Invalid state", the page now names the cause; start a
fresh flow from `google-oauth-start`.

Success is a page headed "Google Photos linked" with an album id, and an empty
album in Google Photos.

## 7. GitHub Pages

```bash
gh auth login --hostname github.com --web --scopes repo,workflow
```

The `workflow` scope is not optional: pushing `.github/workflows/pages.yml`
without it fails with "refusing to allow an OAuth App to create or update
workflow".

Then, on the repo:

1. **Settings → Secrets and variables → Actions → Variables** → new repository
   **variable** (not a secret — the workflow reads `vars.`):
   ```
   SUPABASE_FUNCTIONS_URL = https://dqpxdrvjomtxpdmbrlxi.supabase.co/functions/v1
   ```
2. **Settings → Pages → Source → GitHub Actions.** If this is left on "Deploy
   from a branch", GitHub's built-in Jekyll build publishes the repo root and
   **your site serves README.md instead of the app**, because `web/` is not the
   root. The tell is a workflow run named "pages build and deployment" — that
   one only runs when the source is a branch.
3. **Actions → Deploy to GitHub Pages → Run workflow.** Changing the source does
   not trigger a run.

The workflow publishes only `web/`, so `supabase/` and `scripts/` stay off the
public site, and it substitutes `SUPABASE_FUNCTIONS_URL` into `web/config.js`,
replacing the `YOUR_PROJECT_REF` placeholder. It **deliberately fails** at the
"Inject the functions URL" step if the variable is missing, rather than
publishing a site whose backend URL is a placeholder.

**Pages on a private repo requires GitHub Pro or above.** On a Free account the
repo must be public — which is safe here by design: `web/` contains only the
functions URL, and access keys are minted by `make-key.mjs`, printed once, and
never touch the repo.

## 8. Mint the links

```bash
AUTH_KEY_PEPPER=$(grep '^AUTH_KEY_PEPPER=' .env | cut -d= -f2-) PAGES_BASE_URL='https://aaeberli.github.io/photo-drop' node scripts/make-key.mjs
```

It prints the guest link, the owner link, and the `insert` to run in the SQL
editor. **The keys are shown once** and stored nowhere — only their hashes go
into the database.

Access keys use a URL-safe alphabet with no `+`, `/` or `=`, so share links
survive being pasted anywhere. For handing the guest link round a room, the
script prints an `npx qrcode` one-liner.

---

# Maintenance

## Secrets: what each one does and what rotating it breaks

| Secret | Used by | Rotate freely? | Effect of rotating |
|---|---|---|---|
| `SESSION_JWT_SECRET` | signs session tokens + OAuth `state` | yes | All live browser sessions invalidated; pages silently re-exchange their stored key, so guests notice nothing. **Do not rotate mid-OAuth-flow** — a `state` signed with the old value fails verification. |
| `AUTH_KEY_PEPPER` | access-key hashing | **no** | **Invalidates every minted access key.** Every link stops working and must be re-minted and re-registered. Set once, at setup. |
| `CRON_SECRET` | guards `sync-to-google` | yes | Must be updated in the cron job SQL at the same time, or the mirror stops running. |
| `SETUP_SECRET` | guards `google-oauth-start` | yes | Only affects your own setup URL. Rotate after any setup session where it was exposed. Keep it **hex**. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google OAuth | with care | Existing refresh token becomes invalid; re-run `google-oauth-start`. |
| `ALLOWED_ORIGINS` | CORS | when hosting changes | Wrong value makes every browser call fail. See the troubleshooting table — it looks like a network error, not a CORS error. |

After changing any secret, **redeploy the affected functions**. Env is read at
module load, so warm workers keep serving the old value:

```bash
supabase functions deploy auth upload-url commit photos sync-to-google
```

## Rotating an access key

```sql
-- revoke, keeping photo attribution intact
update access_keys set revoked = true where label = 'guests';
```

**Revocation takes effect on the holder's next request.** Every endpoint except
`/auth` re-reads `access_keys` per request via `requireSession`, so it does not
wait out the holder's session token. This costs one indexed lookup per request
and is the reason "revoke" means revoke: verifying the JWT alone would leave a
revoked key working for up to `SESSION_TTL_SECONDS` (12h by default), because
the token stays cryptographically valid until it expires.

Mint a replacement without disturbing the other link:

```bash
AUTH_KEY_PEPPER=… PAGES_BASE_URL=… ONLY=owner EXPIRES_DAYS=30 node scripts/make-key.mjs
```

`ONLY` is `guest` or `owner`. `EXPIRES_DAYS` sets `expires_at`; without it a link
is valid until revoked, which is worth a thought for something forwarded into
group chats. Expiry is enforced on every request, same path as revocation.

Rotating `SESSION_JWT_SECRET` remains the blunt instrument — it invalidates
every session everywhere at once. Guests recover transparently, because their
page re-exchanges the key it still holds in `localStorage`; a revoked key
cannot.

Photos keep their `uploaded_by_key` link after revocation (`on delete set null`
only fires on deletion, and you should revoke rather than delete):

```sql
select k.label, count(*) as photos, max(p.created_at) as latest
  from photos p
  left join access_keys k on k.id = p.uploaded_by_key
 group by k.label order by photos desc;
```

## Re-linking Google Photos

Needed when the refresh token dies — every 7 days while in Testing, or after you
revoke the app at <https://myaccount.google.com/permissions>.

Just re-open the `google-oauth-start` URL. The album id is remembered in
`google_oauth`, so you rejoin the same album and the queue drains on the next
cron tick.

The album title is set **once**, on creation. `GOOGLE_ALBUM_TITLE` is ignored
afterwards because `ensureAlbum` returns early when `album_id` is set. Rename in
the Photos app instead — the app addresses the album by id. If you delete the
album, force a new one:

```sql
update google_oauth set album_id = null, album_title = null;
```

Never create the album by hand: `appendonly` can only write to albums the app
itself created.

## Health checks

```sql
select * from storage_usage();
select status, count(*) from photos group by status;
select last_sync_run_at, last_sync_error from sync_state;
select ip, count(*) from auth_attempts where ok = false
  and at > now() - interval '1 day' group by ip order by 2 desc;
```

`photos.status` tracks only the Google mirror: `pending → syncing → synced`. The
collage does not consult it — it lists rows with a `display_path`. So a photo can
be live on the collage and not yet in the album, which is intended.

Retry a photo that gave up after five attempts:

```sql
update photos set status = 'pending', attempts = 0, last_error = null
 where status = 'failed';
```

---

# Troubleshooting

Symptoms in the order they tend to appear.

| Symptom | Cause | Fix |
|---|---|---|
| `supabase link`: *"Your account does not have the necessary privileges"* | Project ref not in an org your logged-in account belongs to. 403 not 404, so it does not leak existence. | `supabase projects list`; log in as the right identity |
| CLI refuses to prompt; *"set the env var correctly: SUPABASE_DB_PASSWORD"* | The CLI detects agent env vars (`CLAUDECODE`, `AI_AGENT`) and goes non-interactive. Not a TTY problem. | Add `--agent no`, or run in a plain terminal |
| `db push`: `Connection terminated unexpectedly` | Network blocks Postgres. Firewall SYN-ACKs 5432/6543 then drops the protocol; server never answers `SSLRequest`. | Apply `supabase/sql/*` in the dashboard, or run from a hotspot |
| `relation "supabase_migrations.schema_migrations" does not exist` | That schema is created by the first successful `db push`. | Skip it, or create the schema first (step 2) |
| Function returns `{"code":"WORKER_ERROR"}` | A required secret is empty. `requireEnv` throws at module scope, so the worker dies before your request. | `supabase secrets list`, look for the empty-string digest `e3b0c442…` |
| `google-oauth-start` → `unauthorised` | `SETUP_SECRET` mismatch. Base64 `+` decodes to a space in a querystring. | Percent-encode (`%2B`, `%2F`, `%3D`), or regenerate as hex |
| Google: `Access blocked: … has not completed the Google verification process` | Publishing status is Testing and the account is not a Test user — or is Production and Photos requires verification. | Testing + add yourself as a Test user |
| Callback → `Invalid state` | Reloading a stale callback URL. Codes are single-use, state is time-limited. | Start again from `google-oauth-start`; read the reason on the page |
| Pages serves README.md | Pages source is "Deploy from a branch", so Jekyll publishes the repo root. | Source → GitHub Actions, then run the workflow |
| Pages workflow fails at "Inject the functions URL" | `SUPABASE_FUNCTIONS_URL` repository **variable** missing. | Add it under Actions → Variables (variable, not secret) |
| App loads, then *"Could not reach the server"* | Almost always CORS: `ALLOWED_ORIGINS` does not exactly match the Pages origin. A CORS block is indistinguishable from a network failure in JS. | Set origin only, no path or trailing slash; redeploy the functions |
| A deploy appears to change nothing | GitHub Pages serves `Cache-Control: max-age=600`, so the browser runs JS up to 10 minutes old without revalidating. | Hard-reload, or add `?v=2` to the page URL. The workflow stamps the commit sha onto asset URLs to prevent this; the HTML itself is still 10-minute cached and Pages cannot be told otherwise |
| Collage frozen on *"Loading the album…"* | Fixed: `selectPhotos` used to loop forever when the album had fewer photos than the template had tiles, blocking the main thread. | Ensure `web/collage.js` contains `const FEW =` and `let guard =`; if not, you are on a cached or pre-fix copy |
| Uploads fine, album stays empty | Mirror failing. | `select last_sync_error from sync_state` — `invalid_grant` means re-link Google |
| Guest sees "The album is full" | `DISPLAY_BUDGET_BYTES` reached. | `select * from storage_usage();` and free space or raise the budget |
| Everything dead after a quiet week | Free project paused after 7 days idle. | Unpause in the dashboard; check the cron job still exists |
| Photo in album but not the collage | `display_path is null` — the browser had no decoder for that file. | Expected and rare; the uploader tells the guest at the time |

---

# Local development

A mock backend stands in for Supabase and Google, and keeps uploaded display
copies in memory and serves them back — so you can watch a photo you just
uploaded appear in the collage, which is the only real way to check that
downscaling, orientation baking and the two-PUT flow work.

```bash
node scripts/dev-mock.mjs
```

- guest upload: <http://localhost:8787/#k=GUEST-KEY>
- owner collage: <http://localhost:8787/collage.html#k=OWNER-KEY>
- rejection path: <http://localhost:8787/#k=WRONG>
- empty album: <http://localhost:8787/mock-control?clear>
- storage-full guard: <http://localhost:8787/mock-control?full=1>

It also widens the pages' CSP just enough to reach localhost, so the production
policy in the HTML stays tight.

# Layout

```
web/                       static site published to Pages
  index.html  upload.js     guest upload page
  collage.html  collage.js  owner collage page
  auth.js                   fragment -> token exchange, per-role key storage
  downscale.js              in-browser display copy (WebP, JPEG fallback)
  config.js                 functions URL (rewritten at deploy time) + tuning
supabase/
  sql/                      paste-sized scripts for the dashboard SQL editor
  migrations/               the same schema, for `db push`
  functions/_shared/        http/CORS, env, session JWT, db, Google client
  functions/auth            key -> session token
  functions/upload-url      signed direct-to-Storage URLs for both files
  functions/commit          confirm both objects, insert the row, queue mirror
  functions/photos          collage listing with cached signed URLs
  functions/sync-to-google  staged original -> album, then delete staged
  functions/google-oauth-*  one-time account linking
scripts/
  make-key.mjs              mint the guest and owner links
  dev-mock.mjs              local mock backend
```
