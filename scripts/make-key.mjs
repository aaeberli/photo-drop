#!/usr/bin/env node
/**
 * Mints the two access keys and prints the share links plus the SQL to register
 * them. Plaintext keys are shown once here and stored nowhere — only
 * sha256(key || pepper) goes into the database.
 *
 *   AUTH_KEY_PEPPER=... PAGES_BASE_URL=https://you.github.io/photo-drop \
 *     node scripts/make-key.mjs
 *
 * Two keys, not one, because the scopes differ:
 *   guest  upload only — hand this link to everybody. It cannot open the
 *          collage, so a guest who shares it on cannot show the whole album.
 *   owner  view only — your collage screen. It cannot upload.
 *
 * Pass a label suffix to tell one batch of links from another:
 *   node scripts/make-key.mjs "birthday"
 *
 * Set EXPIRES_DAYS to give the links a deadline. A link with no expiry stays
 * valid until you explicitly revoke it, which for something handed round a room
 * and forwarded into group chats is worth thinking about:
 *   EXPIRES_DAYS=30 node scripts/make-key.mjs "birthday"
 *
 * Set ONLY=guest or ONLY=owner to mint one side without disturbing the other.
 */

import { createHash, randomBytes } from "node:crypto";

const suffix = process.argv[2] ? ` (${process.argv[2]})` : "";
const pepper = process.env.AUTH_KEY_PEPPER;
const base = (process.env.PAGES_BASE_URL ?? "https://example.github.io/photo-drop").replace(/\/$/, "");

if (!pepper) {
  console.error("AUTH_KEY_PEPPER is not set. Use the same value as the edge function secret.");
  process.exit(1);
}

// 20 random bytes = 160 bits. Crockford-ish base32 (no I, L, O, U) so the key
// survives being read aloud, retyped, or squinted at in a QR code.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

function mintKey() {
  const bytes = randomBytes(20);
  let key = "";
  for (let i = 0; i < bytes.length; i++) {
    key += ALPHABET[bytes[i] % ALPHABET.length];
    if (i % 5 === 4 && i !== bytes.length - 1) key += "-";
  }
  return key;
}

const hash = (key) => createHash("sha256").update(`${key}${pepper}`).digest("hex");
const sql = (s) => s.replace(/'/g, "''");

const days = Number(process.env.EXPIRES_DAYS);
const expires = Number.isFinite(days) && days > 0
  ? new Date(Date.now() + days * 86400_000).toISOString()
  : null;
const expiresSql = expires ? `'${expires}'` : "null";

const only = (process.env.ONLY ?? "").toLowerCase();
const wantGuest = only !== "owner";
const wantOwner = only !== "guest";

const rows = [];
const out = [];

if (wantGuest) {
  const guest = mintKey();
  rows.push(`  ('guests${sql(suffix)}', '${hash(guest)}', array['upload'], ${expiresSql})`);
  out.push(`
=== Guest link — give this one to everybody ==========================
${base}/#k=${guest}

  Opens straight on the upload buttons, no sign-in step. Upload only:
  it cannot open the collage.

  Revoke:
    update access_keys set revoked = true where key_hash = '${hash(guest)}';

  QR code, for handing round a room:
    npx --yes qrcode -o guest.png "${base}/#k=${guest}"`);
}

if (wantOwner) {
  const owner = mintKey();
  rows.push(`  ('owner collage${sql(suffix)}', '${hash(owner)}', array['view'], ${expiresSql})`);
  out.push(`
=== Owner link — the collage screen, keep this one ===================
${base}/collage.html#k=${owner}

  View only: it cannot upload.

  Revoke:
    update access_keys set revoked = true where key_hash = '${hash(owner)}';`);
}

console.log(`${out.join("\n")}

=== Register (Supabase SQL editor) ==================================
insert into access_keys (label, key_hash, scopes, expires_at) values
${rows.join(",\n")};

Expiry: ${expires ? `${days} days, ${expires}` : "none — valid until revoked. Set EXPIRES_DAYS to add one."}

Revoking takes effect on the next request: every endpoint re-reads the key,
so it does not wait for the holder's session token to expire.

The keys above are stored nowhere. Copy the links now.
`);
