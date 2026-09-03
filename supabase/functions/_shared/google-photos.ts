/**
 * Google Photos Library API client. Write-only.
 *
 * Google Photos is the archive here: it holds the original file at full
 * resolution with its EXIF intact. It is never read back — the collage renders
 * the display copies in Supabase Storage instead. That is a deliberate choice,
 * because the read side of this API is painful post-March-2025:
 * `photoslibrary.readonly` was removed, an app can only see items it uploaded
 * itself, and every `baseUrl` it hands out dies after 60 minutes.
 * https://developers.google.com/photos/support/updates
 *
 * Writing still needs `appendonly`, and that scope only permits appending to an
 * album the app itself created — so the album is created here on first run and
 * cannot be an album you made in the Google Photos app.
 */

import { db } from "./db.ts";
import { requireEnv } from "./env.ts";

/**
 * Write-only. Requesting no read scope keeps the consent screen minimal and
 * means a leaked token cannot enumerate the album.
 */
export const GOOGLE_SCOPES = "https://www.googleapis.com/auth/photoslibrary.appendonly";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://photoslibrary.googleapis.com/v1";

export interface GoogleOAuthRow {
  refresh_token: string;
  album_id: string | null;
  album_title: string | null;
}

// Access tokens last an hour; reuse within a warm isolate.
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function loadOAuthRow(): Promise<GoogleOAuthRow> {
  const { data, error } = await db()
    .from("google_oauth")
    .select("refresh_token, album_id, album_title")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw new Error(`google_oauth read failed: ${error.message}`);
  if (!data) {
    throw new Error(
      "Google account not linked yet. Open the google-oauth-start function once to grant access.",
    );
  }
  return data as GoogleOAuthRow;
}

export async function getAccessToken(refreshToken: string): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant here almost always means the OAuth app is still in
    // "Testing" (refresh tokens expire after 7 days) or consent was revoked.
    throw new Error(
      `google token refresh failed (${res.status}): ${body.error ?? "unknown"} ${body.error_description ?? ""}`.trim(),
    );
  }

  tokenCache = {
    token: body.access_token as string,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

async function api(accessToken: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** Creates the app-owned album on first use and remembers its id. */
export async function ensureAlbum(accessToken: string, row: GoogleOAuthRow): Promise<string> {
  if (row.album_id) return row.album_id;

  const title = Deno.env.get("GOOGLE_ALBUM_TITLE") ?? "Photo Drop";
  const created = await api(accessToken, "/albums", {
    method: "POST",
    body: JSON.stringify({ album: { title } }),
  });

  const albumId = created.id as string;
  const { error } = await db()
    .from("google_oauth")
    .update({ album_id: albumId, album_title: title, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`could not persist album id: ${error.message}`);

  return albumId;
}

/**
 * Step 1 of the two-step upload: push raw bytes, get an upload token back.
 * The token is valid for one `batchCreate` call.
 */
export async function uploadBytes(
  accessToken: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string> {
  const res = await fetch(`${API}/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/octet-stream",
      "X-Goog-Upload-Content-Type": mimeType,
      "X-Goog-Upload-Protocol": "raw",
      "X-Goog-Upload-File-Name": filename,
    },
    body: bytes,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`/uploads failed (${res.status}): ${text.slice(0, 500)}`);
  if (!text.trim()) throw new Error("/uploads returned an empty upload token");
  return text.trim();
}

export interface BatchCreateItem {
  uploadToken: string;
  filename: string;
  description?: string | null;
}

export interface BatchCreateResult {
  uploadToken: string;
  mediaItemId: string | null;
  error: string | null;
}

/** Step 2: turn upload tokens into media items inside the album. Max 50/call. */
export async function batchCreate(
  accessToken: string,
  albumId: string,
  items: BatchCreateItem[],
): Promise<BatchCreateResult[]> {
  if (items.length === 0) return [];
  if (items.length > 50) throw new Error("batchCreate accepts at most 50 items");

  const body = await api(accessToken, "/mediaItems:batchCreate", {
    method: "POST",
    body: JSON.stringify({
      albumId,
      newMediaItems: items.map((i) => ({
        description: i.description ?? undefined,
        simpleMediaItem: { fileName: i.filename, uploadToken: i.uploadToken },
      })),
    }),
  });

  const results = (body.newMediaItemResults ?? []) as Array<{
    uploadToken: string;
    status?: { code?: number; message?: string };
    mediaItem?: { id: string };
  }>;

  return results.map((r) => ({
    uploadToken: r.uploadToken,
    mediaItemId: r.mediaItem?.id ?? null,
    // status.code 0 (or absent) is OK; anything else is a per-item failure.
    error: r.mediaItem?.id ? null : (r.status?.message ?? "unknown batchCreate error"),
  }));
}
