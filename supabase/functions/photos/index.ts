/**
 * GET /photos  ->  { photos: [{ id, url, width, height, createdAt }], count }
 *
 * Lists the display copies for the collage. Google Photos is not involved: this
 * reads Supabase Storage, so a photo appears here seconds after upload and an
 * expired Google refresh token cannot take the collage down.
 *
 * Signed URLs are cached in the photos row and reused until they are close to
 * expiry, so every poll returns the SAME url for a given photo. That matters
 * more than it looks: a url that changed each minute would bust the browser
 * cache and re-download every tile on every reshuffle. Stable urls mean a
 * collage running all day fetches each photo exactly once.
 */

import { fail, json, preflight } from "../_shared/http.ts";
import { db, DISPLAY_BUCKET } from "../_shared/db.ts";
import { hasScope, readSession } from "../_shared/session.ts";
import { numEnv } from "../_shared/env.ts";

const URL_TTL_SECONDS = numEnv("DISPLAY_URL_TTL_SECONDS", 7 * 24 * 60 * 60);
/** Re-sign this far ahead of expiry so a URL never dies mid-slideshow. */
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
const MAX_PHOTOS = numEnv("COLLAGE_MAX_PHOTOS", 2000);

interface Row {
  id: string;
  display_path: string;
  display_width: number | null;
  display_height: number | null;
  signed_url: string | null;
  signed_url_expires_at: string | null;
  created_at: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET") return fail(req, 405, "method not allowed");

  const session = await readSession(req);
  if (!hasScope(session, "view")) return fail(req, 401, "not authorised to view");

  const supabase = db();
  const { data, error } = await supabase
    .from("photos")
    .select("id, display_path, display_width, display_height, signed_url, signed_url_expires_at, created_at")
    .not("display_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_PHOTOS);

  if (error) {
    console.error("photos read failed", error);
    return fail(req, 500, "internal error");
  }

  const rows = (data ?? []) as Row[];
  const cutoff = Date.now() + RENEW_MARGIN_MS;
  const needsUrl = rows.filter(
    (r) => !r.signed_url ||
           !r.signed_url_expires_at ||
           new Date(r.signed_url_expires_at).getTime() < cutoff,
  );

  if (needsUrl.length > 0) {
    try {
      await mintUrls(needsUrl);
    } catch (e) {
      console.error("signing display urls failed", e);
      // Fall through: rows that already have a valid url are still servable.
    }
  }

  const photos = rows
    .filter((r) => r.signed_url)
    .map((r) => ({
      id: r.id,
      url: r.signed_url!,
      width: r.display_width,
      height: r.display_height,
      createdAt: r.created_at,
    }));

  return json(req, { photos, count: photos.length });
});

/** Signs a batch of display objects and writes the urls back onto their rows. */
async function mintUrls(rows: Row[]) {
  const supabase = db();
  const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();

  const { data, error } = await supabase
    .storage.from(DISPLAY_BUCKET)
    .createSignedUrls(rows.map((r) => r.display_path), URL_TTL_SECONDS);

  if (error) throw new Error(`createSignedUrls failed: ${error.message}`);

  const byPath = new Map((data ?? []).map((d) => [d.path ?? "", d.signedUrl]));

  await Promise.all(
    rows.map(async (row) => {
      const signedUrl = byPath.get(row.display_path);
      if (!signedUrl) {
        console.warn(`no signed url returned for ${row.display_path}`);
        return;
      }
      // Mutate in place so this request serves the fresh url without re-reading.
      row.signed_url = signedUrl;
      row.signed_url_expires_at = expiresAt;
      const { error: updateError } = await supabase
        .from("photos")
        .update({ signed_url: signedUrl, signed_url_expires_at: expiresAt })
        .eq("id", row.id);
      if (updateError) console.warn(`could not cache url for ${row.id}: ${updateError.message}`);
    }),
  );
}
