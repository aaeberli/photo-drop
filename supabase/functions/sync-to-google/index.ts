/**
 * POST /sync-to-google      (header: x-cron-secret)
 *
 * Mirrors staged originals into the private Google Photos album at full
 * resolution with their EXIF intact, then deletes the staged object so Google
 * Photos becomes the only place the original exists. The display copy in the
 * `display` bucket is untouched and stays permanently.
 *
 * Driven by pg_cron every minute, and also kicked opportunistically by /commit.
 * Nothing on the collage depends on this succeeding.
 */

import { fail, json, safeEqual } from "../_shared/http.ts";
import { db, UPLOAD_BUCKET } from "../_shared/db.ts";
import { numEnv, requireEnv } from "../_shared/env.ts";
import {
  batchCreate,
  ensureAlbum,
  getAccessToken,
  loadOAuthRow,
  uploadBytes,
  type BatchCreateItem,
} from "../_shared/google-photos.ts";

const BATCH_SIZE = numEnv("SYNC_BATCH_SIZE", 20);
const MAX_ATTEMPTS = numEnv("SYNC_MAX_ATTEMPTS", 5);

interface PhotoRow {
  id: string;
  original_path: string;
  original_mime: string;
  original_name: string | null;
  caption: string | null;
  attempts: number;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(req, 405, "method not allowed");

  const provided = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(provided, requireEnv("CRON_SECRET"))) {
    return fail(req, 401, "unauthorised");
  }

  const supabase = db();
  const startedAt = new Date().toISOString();

  // Pass max_attempts through so SYNC_MAX_ATTEMPTS is the single source of
  // truth — otherwise SQL would keep claiming rows this function calls dead.
  const { data: claimed, error: claimError } = await supabase.rpc("claim_pending_photos", {
    batch_size: BATCH_SIZE,
    max_attempts: MAX_ATTEMPTS,
  });
  if (claimError) {
    console.error("claim_pending_photos failed", claimError);
    return fail(req, 500, "could not claim photos");
  }

  const photos = (claimed ?? []) as PhotoRow[];
  if (photos.length === 0) {
    await supabase.from("sync_state").update({ last_sync_run_at: startedAt }).eq("id", 1);
    return json(req, { claimed: 0, synced: 0, failed: 0 });
  }

  let accessToken: string;
  let albumId: string;
  try {
    const row = await loadOAuthRow();
    accessToken = await getAccessToken(row.refresh_token);
    albumId = await ensureAlbum(accessToken, row);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("google setup failed", message);
    // Hand the whole batch back so the next run retries it.
    await supabase
      .from("photos")
      .update({ status: "pending", last_error: message })
      .in("id", photos.map((p) => p.id));
    await supabase
      .from("sync_state")
      .update({ last_sync_run_at: startedAt, last_sync_error: message })
      .eq("id", 1);
    return fail(req, 502, "google photos unavailable", { detail: message });
  }

  // --- step 1: push bytes, collect upload tokens -----------------------------
  const items: BatchCreateItem[] = [];
  const photoByToken = new Map<string, PhotoRow>();
  const failures: Array<{ photo: PhotoRow; error: string }> = [];

  for (const photo of photos) {
    try {
      const { data: blob, error } = await supabase
        .storage.from(UPLOAD_BUCKET)
        .download(photo.original_path);
      if (error || !blob) throw new Error(`storage download failed: ${error?.message ?? "missing"}`);

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const filename = photo.original_name ?? photo.original_path.split("/").pop()!;
      const uploadToken = await uploadWithRetry(accessToken, bytes, filename, photo.original_mime);

      items.push({ uploadToken, filename, description: photo.caption });
      photoByToken.set(uploadToken, photo);
    } catch (e) {
      failures.push({ photo, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- step 2: create the media items inside the album ----------------------
  const syncedPaths: string[] = [];

  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    let results;
    try {
      results = await batchCreate(accessToken, albumId, chunk);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      for (const item of chunk) failures.push({ photo: photoByToken.get(item.uploadToken)!, error });
      continue;
    }

    for (const r of results) {
      const photo = photoByToken.get(r.uploadToken);
      if (!photo) continue;
      if (r.mediaItemId) {
        syncedPaths.push(photo.original_path);
        // original_path goes null: the original now lives only in the album.
        await supabase
          .from("photos")
          .update({
            status: "synced",
            google_media_id: r.mediaItemId,
            synced_at: new Date().toISOString(),
            original_path: null,
            last_error: null,
          })
          .eq("id", photo.id);
      } else {
        failures.push({ photo, error: r.error ?? "batchCreate returned no media item" });
      }
    }
  }

  // --- cleanup -------------------------------------------------------------
  // Only ever the staging bucket. The display copies are permanent.
  if (syncedPaths.length > 0) {
    const { error } = await supabase.storage.from(UPLOAD_BUCKET).remove(syncedPaths);
    if (error) console.warn("could not delete staged originals", error.message);
  }

  for (const { photo, error } of failures) {
    const exhausted = photo.attempts >= MAX_ATTEMPTS;
    await supabase
      .from("photos")
      .update({ status: exhausted ? "failed" : "pending", last_error: error.slice(0, 1000) })
      .eq("id", photo.id);
    console.error(`photo ${photo.id} mirror failed (attempt ${photo.attempts}): ${error}`);
  }

  await supabase
    .from("sync_state")
    .update({
      last_sync_run_at: startedAt,
      last_sync_error: failures.length ? failures[0].error.slice(0, 1000) : null,
    })
    .eq("id", 1);

  return json(req, {
    claimed: photos.length,
    synced: syncedPaths.length,
    failed: failures.length,
  });
});

/** Google's /uploads endpoint is occasionally flaky; two quick tries is plenty. */
async function uploadWithRetry(
  accessToken: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string> {
  try {
    return await uploadBytes(accessToken, bytes, filename, mimeType);
  } catch (first) {
    await new Promise((r) => setTimeout(r, 750));
    try {
      return await uploadBytes(accessToken, bytes, filename, mimeType);
    } catch (second) {
      throw new Error(
        `upload failed twice: ${first instanceof Error ? first.message : first} / ` +
          `${second instanceof Error ? second.message : second}`,
      );
    }
  }
}
