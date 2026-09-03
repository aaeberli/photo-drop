# photo-drop

A static site on GitHub Pages. You hand one link to everybody; they open it on
their phone and land straight on upload buttons, no sign-in step. Originals go
to a private Google Photos album that only you can see, at full resolution with
their EXIF intact. A second, owner-only link shows the album as a mosaic collage
that reshuffles every minute.

```
                     ┌─ display copy (1920px WebP) ─→ Supabase Storage ─→ collage
 phone ─ #k=key ─────┤
   github.io         └─ original (untouched)      ─→ staged ─→ Google Photos album
                                                                 (then staging deleted)
```

## Two links, different powers

| | Link | Scope | Can |
|---|---|---|---|
| Guests | `/#k=…` | `upload` | Add photos. **Cannot open the collage.** |
| You | `/collage.html#k=…` | `view` | Watch the collage. **Cannot upload.** |

The split matters because the guest link is going to everybody, and from there
into group chats. Upload-only means a guest who forwards it cannot show a
stranger the whole album — the worst they can do is add a photo.

`scripts/make-key.mjs` mints both.

## How the auth works, and why

Each link carries a 160-bit access key in the URL **fragment**:

```
https://you.github.io/photo-drop/#k=A7K3M-QP2XV-…
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
third-party scripts anywhere. If you later add an analytics snippet or a font
CDN, you are widening the only hole in this design.

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
then the staged copy is deleted. After that the original exists only in your
album.

**Display copy** — re-encoded in the browser, capped at **1920px** on the long
edge, **WebP** q0.80 (JPEG fallback if the browser cannot encode WebP).
Permanent, and the only thing the collage renders. Typically 80–350 KB. See
[Storage and the free tier](#storage-and-the-free-tier) for how those numbers
were arrived at.

Resizing happens on the phone rather than the server because Supabase edge
functions run on Deno with no native image library — doing it server-side would
mean shipping a WASM decoder, and none of the practical ones handle HEIC, which
is exactly what an iPhone hands you. The phone already has decoders for whatever
its own camera produces.

Two useful side effects of going through a canvas: EXIF orientation is baked
into the pixels, so a photo shot sideways is upright in the collage without the
renderer knowing anything about it; and all metadata is dropped, so **the copy
living in Supabase carries no GPS**. Only the Google Photos original does.

### Why the collage does not read Google Photos

It could, and an earlier cut of this did. Reading that API is worse in every
way:

| | Reading Google Photos | Reading Storage (chosen) |
|---|---|---|
| Scopes needed | `appendonly` + `readonly.appcreateddata` | `appendonly` only |
| URL lifetime | `baseUrl` dies after 60 min | 7-day signed URL, cached and reused |
| Browser caching | Defeated — URLs rotate | Works — same URL every poll |
| Photo appears | After the Google mirror succeeds | Seconds after upload |
| Google token lapses | Collage down | Collage fine, mirror falls behind |

The caching row is the one that bites hardest in practice. A collage left
running on a screen reshuffles 1,440 times a day; with rotating URLs every tile
is a fresh download and you burn gigabytes of egress. With stable URLs each
photo is fetched exactly once.

So Google Photos here is **write-only**: the app requests no read scope at all,
which also means a leaked token cannot enumerate your album.

## Storage and the free tier

The Supabase free plan gives **1 GB file storage** and **5 GB egress per month**.
Both matter here, and they push in different directions.

### Sizing the display copy

Measured on this project, from a 4032×3024 (12 MP) source, across three content
difficulties:

| content | source JPEG | JPEG 2560 q82 | JPEG 1920 q78 | **WebP 1920 q78** |
|---|---|---|---|---|
| smooth — sky, portrait | 1244 KB | 166 KB | 57 KB | **16 KB** |
| typical scene | 1619 KB | 264 KB | 134 KB | **42 KB** |
| busy — foliage, a crowd | 3246 KB | 660 KB | 352 KB | **233 KB** |

Two conclusions drove the defaults:

**WebP, not JPEG.** At matched visual quality it is ~35% smaller on the hardest
content and several times smaller on smooth content. There is no quality cost
and every browser that can decode a phone photo can encode WebP, so this is free.
`downscale.js` probes for encoder support once and falls back to JPEG.

**1920, not 2560.** After the format, `maxEdge` dominates — 2560→1920 is a ~40%
saving. And 1920 is not a compromise for most screens: the largest mosaic tile
spans 2 of 4 columns, so it is exactly 1920 CSS px wide on a 3840px 4K display.
A 1920 copy fills it pixel for pixel. Only a high-dpr desktop monitor at desk
distance wants more, and that is the one case to raise `displayMaxEdge`.

Caveat on the absolute numbers: those test images are synthetic and compress
better than real photographs, which carry more true entropy. Trust the ratios
between columns; for real photos budget **80–350 KB, averaging ~250 KB**. At
that average, 1 GB holds roughly **4,000 photos** — versus about 1,200 under the
original 2560/JPEG settings.

### Egress is the constraint that bites first

5 GB/month. One cold load of a 500-photo collage costs 500 × 250 KB ≈ 125 MB, so
about **40 cold loads a month**. "Cold" means a browser that has not cached the
photos: because `/photos` returns the same signed URL on every poll and the
objects are served with `max-age=604800`, a collage left running all day fetches
each photo exactly once, and reopening it in the same browser costs nothing.
Running it on several different screens, or on a device that clears its cache,
is what multiplies this.

### Guard rail

`upload-url` refuses new uploads once stored display data passes
`DISPLAY_BUDGET_BYTES` (default 800 MB, leaving headroom under the 1 GB cap for
originals in transit). Guests see "The album is full. Ask the organiser to make
room." rather than a broken upload.

To check where you stand:

```sql
select * from storage_usage();
```

### The 7-day pause

Free projects pause after 7 consecutive days without database activity, which
would break both links until you unpause manually. The `pg_cron` job in step 3
runs every minute and calls an edge function that queries the database, so it
keeps the project alive as a side effect — 43,200 invocations a month, well
inside the free 500,000. **If you remove that cron job, expect the project to
pause.**

## What you need to know before setting up

Since 31 March 2025 the Library API only lets an app touch its own data.
`photoslibrary.appendonly` permits appending only to an album the *app* created,
so **the album is created via the API on first run — you cannot point this at an
album you made in the Google Photos app.**

And the one that will bite you: while your OAuth app's publishing status is
**Testing** with an External user type, Google expires the refresh token after
**7 days** and the mirror stops. You must publish the app to **Production**.
Photos scopes are "sensitive", so publishing unverified is allowed — you get a
"Google hasn't verified this app" screen on the single occasion you consent, and
a 100-user cap that is irrelevant since you are the only person who authorises
it. If the mirror lapses anyway, the collage keeps working; photos just queue up
in the `uploads` bucket until you re-link.

---

## Setup

### 0. CLI and project

Install the CLI. On Windows, npm global works in practice; Supabase's own
recommendation is Scoop, or a project devDependency run through `npx`:

```bash
npm install -g supabase
```

```bash
supabase login
```

Then **create the project in the dashboard first** — `link` attaches to an
existing project, it does not create one. Copy its ref from the project URL or
Settings → General.

Two things that will stop you here:

- **The free plan allows only 2 active projects** per organisation. If you
  already have two, pause or delete one, or reuse an existing project.
- `supabase link` failing with *"Your account does not have the necessary
  privileges to access this endpoint"* means the ref is not in an organisation
  your logged-in account belongs to. The API returns 403 rather than 404 so it
  does not leak whether the project exists. Check what you can actually reach:

  ```bash
  supabase projects list
  ```

  If the project you want is missing, you are logged into the CLI as a different
  Supabase identity than the one that owns it. A personal access token is
  cleaner than re-running `supabase login`, because it does not depend on which
  account your browser happens to be signed into.

  Generate one at <https://supabase.com/dashboard/account/tokens> **while signed
  in as the account that owns the project**, then either:

  ```bash
  supabase login --token sbp_xxxxxxxx
  ```

  which stores it and replaces whatever account was logged in before — or, to
  keep two accounts usable side by side, set it per terminal session instead.
  The environment variable takes precedence over the stored credential without
  overwriting it:

  ```bash
  export SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx
  ```

  In PowerShell: `$env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxx"`. This only lasts
  for that shell, so all the `supabase` commands below must run in the same one.

  Confirm you are pointed at the right account before going further:

  ```bash
  supabase projects list
  ```

### 1. Supabase

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

```bash
cp .env.example .env
# fill in the four generated secrets with: openssl rand -base64 32
supabase secrets set --env-file .env
```

```bash
supabase functions deploy auth upload-url commit photos sync-to-google google-oauth-start google-oauth-callback
```

`ALLOWED_ORIGINS` must exactly match your Pages origin (`https://you.github.io`,
no trailing slash, no path) or every browser request fails CORS.

### 2. Google Cloud

1. New project → **APIs & Services** → enable **Photos Library API**.
2. **OAuth consent screen**: External. Add one scope:
   `.../auth/photoslibrary.appendonly`
3. **Publish app** → Production. Skip verification, accept the warning screen.
   Do not leave it in Testing — see above.
4. **Credentials** → OAuth client ID → **Web application**. Authorised redirect
   URI, exactly:
   ```
   https://<project-ref>.supabase.co/functions/v1/google-oauth-callback
   ```
5. Put the client id and secret in `.env` and re-run `supabase secrets set`.

Then, signed into the Google account that should own the album, open once in
your own browser:

```
https://<project-ref>.supabase.co/functions/v1/google-oauth-start?setup_secret=<SETUP_SECRET>
```

Consent, and the callback page confirms the album was created.

### 3. Cron

```bash
cp supabase/migrations/0002_cron.sql.template /tmp/cron.sql
# replace __PROJECT_REF__ and __CRON_SECRET__, then run it in the SQL editor
```

`/commit` also kicks the mirror directly, so originals normally reach the album
within seconds; cron is the retry safety net.

### 4. GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → Variables** → new repository
   variable `SUPABASE_FUNCTIONS_URL` =
   `https://<project-ref>.supabase.co/functions/v1`.

The workflow publishes only `web/`, so the function sources and scripts stay off
the public site.

### 5. Mint the two links

```bash
AUTH_KEY_PEPPER='<same value as the secret>' \
PAGES_BASE_URL='https://you.github.io/photo-drop' \
node scripts/make-key.mjs
```

It prints both links once and the SQL to register them. Run the `insert` in the
Supabase SQL editor.

For handing the guest link round a room, a QR code beats reading it aloud — the
script prints an `npx qrcode` one-liner for that.

---

## Local development

A mock backend stands in for Supabase and Google, and keeps your uploaded
display copies in memory and serves them back — so you can watch a photo you
just uploaded appear in the collage, which is the only real way to check that
downscaling, orientation baking and the two-PUT flow work.

```bash
node scripts/dev-mock.mjs
```

- guest upload: <http://localhost:8787/#k=GUEST-KEY>
- owner collage: <http://localhost:8787/collage.html#k=OWNER-KEY>
- rejection path: <http://localhost:8787/#k=WRONG>
- empty album: <http://localhost:8787/mock-control?clear>

It also widens the pages' CSP just enough to reach localhost, so the production
policy in the HTML stays tight.

## Operating notes

- **Where a photo is.** `photos.status` tracks only the Google mirror:
  `pending → syncing → synced`. On `synced` the staged original is deleted and
  `original_path` goes null. The collage does not consult this at all — it lists
  rows that have a `display_path`.
- **`failed` rows** mean five mirror attempts were exhausted; `photos.last_error`
  says why and the original is still sitting in the `uploads` bucket. Set the
  row back to `pending` to retry.
- **Nothing mirroring?** `select last_sync_error from sync_state`. An
  `invalid_grant` there means the refresh token died — almost always the Testing
  publishing status.
- **A photo in the album but not the collage** has `display_path is null`: the
  browser had no decoder for it, so no display copy was made. Rare, and the
  uploader tells the guest ("Added (not shown in the collage)").
- **Storage growth** is the display copies only, ~250 KB each on average. Check
  it with `select * from storage_usage();` and see
  [Storage and the free tier](#storage-and-the-free-tier). Uploads stop cleanly
  at `DISPLAY_BUDGET_BYTES`; to make room, delete rows and their objects from the
  `display` bucket — the originals in Google Photos are unaffected.
- **Rotating a link** is one `insert` plus `update … set revoked = true`. Live
  sessions keep working until their JWT expires (12h); shorten
  `SESSION_TTL_SECONDS` if you want revocation to bite faster.

## Layout

```
web/                       static site published to Pages
  index.html  upload.js     guest upload page
  collage.html  collage.js  owner collage page
  auth.js                   fragment -> token exchange, per-role key storage
  downscale.js              in-browser display copy
  config.js                 functions URL (rewritten at deploy time) + tuning
supabase/
  migrations/0001_init.sql  schema, RLS, both buckets, claim function
  migrations/0002_cron.sql.template
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
