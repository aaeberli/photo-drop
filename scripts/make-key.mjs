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

const guest = mintKey();
const owner = mintKey();

console.log(`
=== Guest link — give this one to everybody ==========================
${base}/#k=${guest}

  Opens straight on the upload buttons, no sign-in step. Upload only:
  it cannot open the collage.

=== Owner link — the collage screen, keep this one ===================
${base}/collage.html#k=${owner}

  View only: it cannot upload.

=== Register both (Supabase SQL editor) ==============================
insert into access_keys (label, key_hash, scopes) values
  ('guests${sql(suffix)}', '${hash(guest)}', array['upload']),
  ('owner collage${sql(suffix)}', '${hash(owner)}', array['view']);

=== Revoke later ====================================================
update access_keys set revoked = true where key_hash = '${hash(guest)}';  -- guests
update access_keys set revoked = true where key_hash = '${hash(owner)}';  -- owner

The keys above are not stored anywhere. Copy the links now.

Tip: for handing the guest link round a room, a QR code beats typing:
  npx --yes qrcode -o guest.png "${base}/#k=${guest}"
`);
