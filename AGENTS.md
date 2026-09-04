# AGENTS.md

Notes for anyone — human or agent — working on this repo. Everything here was
learned the hard way while building and reviewing it. Each item says what the
trap is, why it bites, and how to detect it, because most of these fail
*silently*.

Read the security section before touching `supabase/`, and the "verify, don't
assert" section before answering any question about a vendor's behaviour.

---

## Security: Supabase

### `SECURITY DEFINER` functions in `public` are reachable by `anon`

Supabase exposes the `public` schema over PostgREST, so any function there is
callable at `/rest/v1/rpc/<name>` with the project's anon key — which is
designed to be public and must not be treated as a secret. A `SECURITY DEFINER`
function runs as its owner and **bypasses RLS**, so one reachable function makes
RLS on the tables it touches decorative.

This repo's `claim_pending_photos`, `storage_usage`, `prune_auth_attempts`,
`orphaned_grants`, `grant_rate` and `prune_upload_grants` are all in that
category.

**Three things about fixing it, in increasing order of importance:**

1. `revoke execute ... from public` **does nothing.** Supabase ships
   `alter default privileges in schema public grant all on functions to
   postgres, anon, authenticated, service_role`, so `anon` and `authenticated`
   hold *direct* grants. They do not inherit from `PUBLIC`. Name them:
   `revoke execute on function f(...) from public, anon, authenticated;`

2. **Even that can be a silent no-op.** `REVOKE` only removes grants made *by
   the current user*. If the grant's grantor differs from whatever role your SQL
   editor runs as, the statement succeeds and changes nothing — no error, no
   warning. This happened here.

3. **Therefore the in-function guard is the primary control, not hardening:**

   ```sql
   if current_user not in ('service_role', 'postgres') then
     raise exception 'permission denied for f' using errcode = '42501';
   end if;
   ```

   PostgREST issues `set local role` from the JWT, so a service-role key arrives
   as `service_role`; pg_cron runs jobs as the role that scheduled them,
   normally `postgres`. Everything else is refused regardless of the ACL.

**Every new `SECURITY DEFINER` function in `public` must have this guard.** Add
it when you write the function, not in a later cleanup pass.

**`create or replace function` resets privileges to the schema defaults**, which
hands `EXECUTE` back to `anon`. So every edit to one of these functions reopens
the hole unless the revokes are re-applied — which is a second reason the guard
matters more than the grant.

Detection — `information_schema` cannot answer this, because it hides the
grantor. Use `pg_proc`:

```sql
select p.proname,
       p.prosecdef                            as security_definer,
       p.prosrc like '%permission denied for%' as has_guard,
       pg_get_userbyid(p.proowner)            as owner,
       p.proacl::text                         as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.prosecdef desc, p.proname;
```

Any row with `security_definer = true` and `has_guard = false` is a hole. In
`proacl`, entries read `grantee=privs/grantor`.

### Signed upload URLs enforce nothing about size

A client-supplied `sizeBytes` is advisory: the client can lie, and a signed
upload URL carries no size constraint. **The bucket's `file_size_limit` is the
only server-side enforcement**, because Storage is the only layer that sees the
bytes. Keep these in step, and remember which one is real:

| place | role |
|---|---|
| `web/config.js` → `maxUploadBytes` | what the guest is told, client-side reject |
| `MAX_UPLOAD_BYTES` secret | fail-fast message, post-hoc rejection in `commit` |
| `storage.buckets.file_size_limit` | **the actual limit** |

### Signed read URLs outlive revocation

`/photos` hands out Storage signed URLs with a 7-day TTL. Revoking a key stops
API access on the next request, but any image URL already fetched keeps working
until it expires, with no key needed. Signed URLs are bearer capabilities. The
only levers are a shorter TTL — at the cost of the browser caching that keeps
egress low — or re-uploading objects under new paths.

### Verifying a JWT is not authorization

A session token stays cryptographically valid until it expires. If endpoints
only verify the signature, revoking a key leaves the holder with a working
credential for the whole TTL (12h here). `requireSession` re-reads
`access_keys` on **every** request for exactly this reason. One indexed lookup;
"revoke" has to mean revoke.

### Empty secrets produce an opaque `WORKER_ERROR`

`requireEnv` runs at module scope in `session.ts` and `oauth-state.ts`, so a
missing or **empty** secret kills the worker during import, before any handler
runs. The response is `{"code":"WORKER_ERROR"}` with nothing useful.

`supabase secrets set --env-file` pushes a blank value as an empty string — it
does not skip it. Spot it in `supabase secrets list` by this digest, which is
SHA-256 of the empty string:

```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Other `secrets set` behaviour: it is an **upsert** — names in the file are
overwritten, names absent are left alone; removal needs `secrets unset`.
`SUPABASE_*` names are platform-reserved and must not be in `.env`.

### Fail-closed guards create deployment-order coupling

`upload-url` returns 503 if the rate-limit RPC is missing — correct, since that
guard is the only bound on storage growth. The consequence is that **SQL must be
applied before the functions are deployed**, or every upload fails. Apply
`supabase/sql/*` first, then `supabase functions deploy`.

### Secrets in a querystring end up in logs

`SETUP_SECRET` travels in the `google-oauth-start` URL, so it lands in edge and
CDN logs. Generate it with `openssl rand -hex 32`, never base64: **`+` decodes
to a space in a query string**, so a base64 secret fails comparison with a
useless "unauthorised".

---

## Security: browser and hosting

### A CORS failure is indistinguishable from a network failure

JavaScript cannot see why a cross-origin fetch was blocked. "Could not reach the
server" almost always means `ALLOWED_ORIGINS` does not exactly match the Pages
origin. It must be **scheme + host only** — no path, no trailing slash — because
browsers send the origin, not the page URL.

### `frame-ancestors` is ignored in a `<meta>` element

CSP `frame-ancestors` and `X-Frame-Options` only work as real HTTP headers, and
GitHub Pages does not let you set headers. Adding `frame-ancestors` to the meta
CSP is dead code; the browser says so in the console. Framing is refused in JS
in `auth.js` instead.

### Secrets belong in the fragment, never the querystring

A URL fragment is never transmitted to a server, so a key in `#k=…` stays out of
access logs, CDN logs and `Referer` headers. A `?key=…` does not. Scrub it from
the address bar with `history.replaceState` after reading.

### Capability keys: `localStorage`, tokens: `sessionStorage`

Phones evict background tabs aggressively, so a guest reopening the page would
otherwise hit a dead end. The key persists; the derived token does not. Namespace
the stored key per link role, or two links open in one browser overwrite each
other.

### GitHub Pages caches for 10 minutes

`Cache-Control: max-age=600` on everything. A deploy appears to do nothing, and
you will chase a phantom bug. The workflow stamps the commit SHA onto asset
URLs — **including the ES module imports inside the JS**, since a fresh
`collage.js` pulling a cached `auth.js` mixes versions. The HTML itself is still
10-minute cached and cannot be changed.

Also: Pages on a **private** repo needs GitHub Pro. On Free the repo must be
public — which is fine here by design, since `web/` contains only the functions
URL and the security model puts the secret in the link.

---

## Secret hygiene in git

**This repo published live credentials to a public repo.** `keys.txt` and
`guest.png` (a QR of a share link) were committed and remain fetchable from
history at `raw.githubusercontent.com/<owner>/<repo>/<sha>/keys.txt`.

Rules that came out of it:

1. **Gitignore generated secret files before generating them.** `keys.txt`,
   `keys*.txt`, `guest.png`, `owner.png`, `*.qr.png`, `*.local.sql`,
   `*.filled.sql` are ignored. Add to that list *before* writing a tool that
   emits secrets.
2. **Never fill a tracked template in place.** `20260830120100_cron.sql.template`
   is tracked and contains `__CRON_SECRET__`. Copy it to `cron.local.sql` first.
   `CRON_SECRET` is worse than an access key: it lets anyone trigger
   `sweep-orphans`, which deletes files.
3. **Removing from HEAD is not remediation.** History still serves the blob, and
   forks and GitHub's object store keep copies. **Rotation is the only fix.**
4. **Before any `git add -A`, look at what is staged** and grep for
   secret-shaped strings (`sbp_`, `gho_`, `ghp_`, `sk-`, `AKIA`, `eyJ`, and the
   project's own key format). Do this every time, not once.

---

## Verify, don't assert

Several confident answers in this project's history were wrong, and each cost
real time. Vendor behaviour changes and memory is stale.

Things I got wrong by not checking:

- Claimed Google **rejects redirect URIs with query parameters**. The documented
  rule prohibits the *fragment*; query strings are undocumented either way.
- Claimed publishing an OAuth app to Production unverified is enough for Google
  Photos. Their docs say Photos APIs **must pass verification**; the practical
  route is Testing + a test user, which costs a 7-day refresh token.
- Claimed `npm install -g supabase` is unsupported. It works.
- Said "31 characters, which matches" for `ALLOWED_ORIGINS` from mental
  arithmetic. It was the 31-character *placeholder*; the correct value is 26.
  This sent the user hunting in the wrong place.

Rules:

- Check primary docs, not SEO blog summaries. Two searches disagreed with
  Google's own documentation on the 7-day refresh token rule; the docs were
  right (it keys on **publishing status**, not verification status).
- Never do arithmetic or string comparison in your head when a command can do
  it.
- State plainly what you could not verify. This repo's edge functions cannot be
  typechecked locally without Deno, and `sweep-orphans` deletes files and has
  never been executed — say so rather than implying it is tested.

---

## Debugging: make failures self-describing

### Never swallow the reason

```js
try { ...verify... } catch { return false; }   // cost hours here
```

`jose` reports precisely why a JWT failed. Discarding it turned a one-line
diagnosis into three rounds of guesswork. `verifyState` now returns the error
code, and distinguishes "signed with a different secret" from "expired" by
comparing a truncated hash of the signing secret carried in the token.

Apply the same rule anywhere a `catch {}` hides a cause.

### Review the fixes as suspiciously as the original code

The two worst findings in the third security pass were introduced by the second
pass:

- A per-key upload rate limit — but the guest link is **one key shared by
  everybody**, so it was a cap on the whole party. An abuse fix that created an
  outage.
- `sweep-orphans` decides "delete unless found in `photos`", which is only safe
  while the lookup cannot be truncated. Raising the batch past PostgREST's row
  cap would have deleted live photos. The batch is hard-clamped for that reason
  — do not raise it without paginating the lookup.

### Test the small-N and empty cases

The collage froze the browser tab when the album had **2** photos:
`selectPhotos` looped forever because every draw after the second was a
duplicate. It was never caught because the mock always seeded 12–14. The mock
now takes `?seed=2` explicitly, and `scripts/dev-mock.mjs` has controls for
empty (`?clear`) and storage-full (`?full=1`) states.

### Screenshots lie during transitions

The collage crossfades over 1.4s. Several "the page is black" conclusions were
just screenshots sampled mid-fade, including one that nearly sent us after a
non-existent bug. Read the DOM or wait out the transition before believing a
frame.

### Android hides file inputs badly

`display: none` on `<input type="file">` means the picker **will not open** on
several Android browsers and most in-app WebViews — which is how a link shared
into a chat gets opened. Hide it with `clip-path`/1px instead, and open it from
a real `<button>` calling `input.click()` rather than a `<label for>`.

---

## Known-open risks

Kept here so nobody assumes the review is finished. Details and severity in
`README.md`.

- Leaked keys remain in public git history — rotation is the remediation.
- Signed image URLs (7 days) outlive key revocation.
- `SETUP_SECRET` travels in a querystring.
- Google refresh token stored in plaintext (RLS deny-all, service-role only).
- `uploader_ip` and `upload_grants.ip` retained indefinitely, with no notice to
  guests. GDPR-relevant, and there is still no privacy page.
- One secret signs both session tokens and OAuth `state`.
- The OAuth callback does not pin the Google account, so anyone with
  `SETUP_SECRET` can re-link and break the mirror.
- `clientIp` prefers `cf-connecting-ip` then the **rightmost** `X-Forwarded-For`
  hop. Unverified against a real request — test by sending a fake
  `X-Forwarded-For` and checking what `auth_attempts` records.
