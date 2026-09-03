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

import { fail, json, preflight } from "../_shared/http.ts";
import { db, DISPLAY_BUCKET, UPLOAD_BUCKET } from "../_shared/db.ts";
import { hasScope, readSession } from "../_shared/session.ts";
import { numEnv } from "../_shared/env.ts";

const MAX_BYTES = numEnv("MAX_UPLOAD_BYTES", 25 * 1024 * 1024);

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

  const session = await readSession(req);
  if (!hasScope(session, "upload")) return fail(req, 401, "not authorised to upload");

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

  const { data: usage, error: usageError } = await supabase.rpc("storage_usage").single();
  if (usageError) {
    console.error("storage_usage failed", usageError);
    // Do not block uploads on a bookkeeping failure.
  } else if (Number(usage?.display_bytes ?? 0) >= DISPLAY_BUDGET_BYTES) {
    console.error(`display budget reached: ${usage?.display_bytes} bytes`);
    return fail(req, 507, "The album is full. Ask the organiser to make room.");
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
