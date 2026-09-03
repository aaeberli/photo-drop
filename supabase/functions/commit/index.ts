/**
 * POST /commit
 *   { originalPath, contentType, originalName?, caption?,
 *     displayPath?, displayWidth?, displayHeight? }
 *   -> { id }
 *
 * Called once the browser has finished PUTting both files. Verifies the objects
 * really landed, then queues the original for the Google Photos mirror. The
 * display copy is live for the collage immediately — it does not wait for
 * Google.
 */

import { clientIp, fail, json, preflight } from "../_shared/http.ts";
import { db, DISPLAY_BUCKET, UPLOAD_BUCKET } from "../_shared/db.ts";
import { hasScope, readSession } from "../_shared/session.ts";

const PATH_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z]{3,4}$/;
const DISPLAY_MIMES = new Set(["image/webp", "image/jpeg"]);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, 405, "method not allowed");

  const session = await readSession(req);
  if (!hasScope(session, "upload")) return fail(req, 401, "not authorised to upload");

  let body: {
    originalPath?: string;
    contentType?: string;
    originalName?: string;
    caption?: string;
    displayPath?: string;
    displayType?: string;
    displayWidth?: number;
    displayHeight?: number;
  };
  try {
    body = await req.json();
  } catch {
    return fail(req, 400, "expected a JSON body");
  }

  const originalPath = body.originalPath ?? "";
  if (!PATH_RE.test(originalPath)) return fail(req, 400, "invalid originalPath");

  const displayPath = body.displayPath ?? null;
  if (displayPath !== null && !PATH_RE.test(displayPath)) {
    return fail(req, 400, "invalid displayPath");
  }

  const supabase = db();

  // Confirm the objects exist and read their real sizes, rather than trusting
  // whatever the client claims.
  const original = await statObject(supabase, UPLOAD_BUCKET, originalPath);
  if (original === "error") return fail(req, 500, "internal error");
  if (!original) return fail(req, 409, "upload not found — retry the upload");

  let display: Awaited<ReturnType<typeof statObject>> = null;
  if (displayPath) {
    display = await statObject(supabase, DISPLAY_BUCKET, displayPath);
    if (display === "error") return fail(req, 500, "internal error");
    if (!display) return fail(req, 409, "display copy not found — retry the upload");
  }

  const { data, error } = await supabase
    .from("photos")
    .insert({
      original_path: originalPath,
      original_mime: body.contentType ?? original.mime ?? "application/octet-stream",
      original_bytes: original.size,
      original_name: (body.originalName ?? "").slice(0, 200) || null,

      display_path: display ? displayPath : null,
      display_mime: display
        ? (DISPLAY_MIMES.has(body.displayType ?? "") ? body.displayType : display.mime)
        : null,
      display_width: display ? (Number(body.displayWidth) || null) : null,
      display_height: display ? (Number(body.displayHeight) || null) : null,
      display_bytes: display ? display.size : null,

      caption: (body.caption ?? "").slice(0, 500) || null,
      // Which share link this came in on, so revoking a key can be traced to
      // the photos it let in.
      uploaded_by_key: session.keyId,
      uploader_ip: clientIp(req),
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    // Unique violation = the client retried /commit for the same object.
    if (error.code === "23505") return json(req, { id: null, duplicate: true });
    console.error("photos insert failed", error);
    return fail(req, 500, "could not queue the photo");
  }

  if (!displayPath) {
    // The browser could not decode the file (a HEIC it has no decoder for, say).
    // The original still reaches the album; it just cannot join the collage.
    console.warn(`photo ${data.id} has no display copy and will not appear in the collage`);
  }

  // Nudge the sync worker so originals land in the album in seconds rather than
  // waiting for the next cron tick. Fire-and-forget: cron is the safety net.
  void kickSync();

  return json(req, { id: data.id, inCollage: !!displayPath });
});

/** Returns object metadata, null if absent, or "error" on a storage failure. */
async function statObject(
  supabase: ReturnType<typeof db>,
  bucket: string,
  path: string,
): Promise<{ size: number | null; mime: string | null } | null | "error"> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const filename = path.slice(path.lastIndexOf("/") + 1);

  const { data, error } = await supabase
    .storage.from(bucket)
    .list(dir, { search: filename, limit: 1 });

  if (error) {
    console.error(`storage list failed for ${bucket}/${path}`, error);
    return "error";
  }
  const object = data?.find((o) => o.name === filename);
  if (!object) return null;
  return { size: object.metadata?.size ?? null, mime: object.metadata?.mimetype ?? null };
}

async function kickSync() {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("CRON_SECRET");
  if (!url || !secret) return;
  try {
    await fetch(`${url}/functions/v1/sync-to-google`, {
      method: "POST",
      headers: { "x-cron-secret": secret },
    });
  } catch (e) {
    console.warn("sync kick failed, cron will pick it up", e);
  }
}
