/**
 * POST /upload-url  { contentType, sizeBytes, displayType? }
 *   -> { original: { path, signedUrl }, display?: { path, signedUrl } }
 *
 * Mints one signed URL for the untouched original (staged, then mirrored to
 * Google Photos and deleted) and one for the browser-generated display copy
 * (permanent, rendered by the collage).
 *
 * The browser PUTs the bytes straight at these URLs. Photo bytes never pass
 * through an edge function on the way in: the request body limit there is a
 * low, undocumented few megabytes and a phone photo would blow through it.
 */

import { clientIp, fail, json, preflight } from "../_shared/http.ts";
import { db, DISPLAY_BUCKET, UPLOAD_BUCKET } from "../_shared/db.ts";
import { requireSession } from "../_shared/session.ts";
import { numEnv } from "../_shared/env.ts";

/**
 * Advisory only. The client supplies `sizeBytes` and can lie about it, and a
 * signed upload URL carries no size constraint — so the real ceiling is the
 * bucket's `file_size_limit`, set to match this in 07_upload_grants.sql. This
 * check exists to fail fast with a readable message, not to enforce anything.
 */
const MAX_BYTES = numEnv("MAX_UPLOAD_BYTES", 25 * 1024 * 1024);

/**
 * Per-key ceiling on issued upload URLs per hour. Generous for a real event —
 * a guest posting 60 photos in an hour is unusual but fine — while stopping a
 * script from looping the endpoint to fill the bucket or burn the edge
 * invocation quota.
 */
const MAX_GRANTS_PER_HOUR = numEnv("MAX_GRANTS_PER_HOUR", 120);

/**
 * Refuse new uploads past this much stored display data. The free tier caps
 * file storage at 1 GB and overshooting fails in ways that look like a broken
 * app from a phone, so stop short of it with a message a guest can understand.
 */
const DISPLAY_BUDGET_BYTES = numEnv("DISPLAY_BUDGET_BYTES", 800 * 1024 * 1024);

const DISPLAY_EXTENSION: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, 405, "method not allowed");

  const auth = await requireSession(req, "upload");
  if (!auth.ok) return fail(req, auth.status, auth.error);

  let body: { contentType?: string; sizeBytes?: number; displayType?: string | null };
  try {
    body = await req.json();
  } catch {
    return fail(req, 400, "expected a JSON body");
  }

  const contentType = (body.contentType ?? "").toLowerCase();
  const ext = EXTENSION_BY_MIME[contentType];
  if (!ext) return fail(req, 415, `unsupported file type: ${contentType || "(none)"}`);

  const displayType = body.displayType ? body.displayType.toLowerCase() : null;
  if (displayType && !DISPLAY_EXTENSION[displayType]) {
    return fail(req, 415, `unsupported display type: ${displayType}`);
  }

  const size = Number(body.sizeBytes ?? 0);
  if (!Number.isFinite(size) || size <= 0) return fail(req, 400, "sizeBytes is required");
  if (size > MAX_BYTES) {
    return fail(req, 413, `file is too large (max ${Math.floor(MAX_BYTES / 1024 / 1024)} MB)`);
  }

  const supabase = db();

  // Rate limit before doing any work, so a loop is cheap to refuse.
  const { data: recent, error: rateError } = await supabase
    .rpc("recent_grant_count", { p_key_id: auth.session.keyId, window_minutes: 60 });
  if (rateError) {
    console.error("recent_grant_count failed", rateError);
    // Fail closed: this guard is the only bound on staging-bucket growth.
    return fail(req, 503, "Busy, try again in a moment.");
  }
  if (Number(recent ?? 0) >= MAX_GRANTS_PER_HOUR) {
    console.warn(`grant rate limit hit for key ${auth.session.keyId}: ${recent}`);
    return fail(req, 429, "Too many uploads from this link. Try again later.");
  }

  const { data: usage, error: usageError } = await supabase.rpc("storage_usage").single();
  if (usageError) {
    console.error("storage_usage failed", usageError);
    // Do not block uploads on a bookkeeping failure.
  } else {
    // Count originals still in transit, not just committed display copies —
    // they occupy the same 1 GB.
    const used = Number(usage?.display_bytes ?? 0) + Number(usage?.staged_bytes ?? 0);
    if (used >= DISPLAY_BUDGET_BYTES) {
      console.error(`storage budget reached: ${used} bytes`);
      return fail(req, 507, "The album is full. Ask the organiser to make room.");
    }
  }

  // Paths are server-generated and share one id, so the two halves of an upload
  // are always traceable to each other and a client cannot choose where its
  // bytes land — meaning it cannot overwrite someone else's pending upload.
  const now = new Date();
  const prefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const id = crypto.randomUUID();

  const original = await sign(supabase, UPLOAD_BUCKET, `${prefix}/${id}.${ext}`);
  if (!original) return fail(req, 500, "could not prepare upload");

  let display = null;
  if (displayType) {
    display = await sign(supabase, DISPLAY_BUCKET, `${prefix}/${id}.${DISPLAY_EXTENSION[displayType]}`);
    if (!display) return fail(req, 500, "could not prepare upload");
  }

  // Record what was handed out. This is what makes the orphan sweep exact: an
  // uncommitted grant past its grace period is definitively abandoned bytes,
  // not a stray object of unknown purpose.
  const { error: grantError } = await supabase.from("upload_grants").insert({
    key_id: auth.session.keyId,
    original_path: original.path,
    display_path: display?.path ?? null,
    ip: clientIp(req),
  });
  if (grantError) {
    console.error("upload_grants insert failed", grantError);
    return fail(req, 503, "Could not start the upload. Try again.");
  }

  return json(req, { original, display });
});

async function sign(
  supabase: ReturnType<typeof db>,
  bucket: string,
  path: string,
): Promise<{ path: string; signedUrl: string } | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) {
    console.error(`createSignedUploadUrl failed for ${bucket}/${path}`, error);
    return null;
  }
  return { path, signedUrl: data.signedUrl };
}
