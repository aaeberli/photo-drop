/**
 * GET /google-oauth-callback?code=...&state=...
 *
 * Register EXACTLY this URL as the authorised redirect URI on the Google OAuth
 * client. It is a separate function from google-oauth-start precisely so the
 * redirect URI carries no query string of its own — Google rejects those.
 *
 * Stores the refresh token (server-side only, RLS deny-all table) and creates
 * the album if it does not exist yet.
 */

import { db } from "../_shared/db.ts";
import { requireEnv } from "../_shared/env.ts";
import { ensureAlbum, getAccessToken } from "../_shared/google-photos.ts";
import { redirectUri, verifyState } from "../_shared/oauth-state.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);

  const error = url.searchParams.get("error");
  if (error) return page(400, "Consent denied", `Google returned: ${escapeHtml(error)}`);

  if (!(await verifyState(url.searchParams.get("state")))) {
    return page(400, "Invalid state", "Start again from google-oauth-start.");
  }

  const code = url.searchParams.get("code");
  if (!code) return page(400, "Missing code", "No authorisation code in the callback.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return page(502, "Token exchange failed", escapeHtml(JSON.stringify(body).slice(0, 800)));
  }
  if (!body.refresh_token) {
    return page(
      502,
      "No refresh token returned",
      "Google only issues one with access_type=offline and prompt=consent. " +
        "Revoke the app at myaccount.google.com/permissions and try again.",
    );
  }

  const supabase = db();
  const { error: upsertError } = await supabase.from("google_oauth").upsert(
    { id: 1, refresh_token: body.refresh_token, updated_at: new Date().toISOString() },
    { onConflict: "id" },
  );
  if (upsertError) return page(500, "Could not store token", escapeHtml(upsertError.message));

  // Create the album now so the first guest upload does not have to wait, and
  // so you can confirm it exists before handing the link out.
  let albumNote: string;
  try {
    const { data: row } = await supabase
      .from("google_oauth")
      .select("refresh_token, album_id, album_title")
      .eq("id", 1)
      .single();
    const accessToken = await getAccessToken(body.refresh_token);
    const albumId = await ensureAlbum(accessToken, row!);
    albumNote = `Album ready (id <code>${escapeHtml(albumId)}</code>).`;
  } catch (e) {
    albumNote = `Token stored, but the album could not be created yet: ${
      escapeHtml(e instanceof Error ? e.message : String(e))
    }`;
  }

  return page(
    200,
    "Google Photos linked",
    `${albumNote}<br><br>Remember: the OAuth app must be published to <b>Production</b>, ` +
      `otherwise this refresh token expires in 7 days.`,
  );
});

function page(status: number, title: string, detail: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(title)}</title>
     <style>
       body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;
            min-height:100vh;background:#111;color:#eee;padding:2rem}
       div{max-width:34rem}
       h1{font-size:1.4rem;margin:0 0 .75rem}
       code{background:#000;padding:.1em .35em;border-radius:3px;font-size:.9em}
     </style>
     <div><h1>${escapeHtml(title)}</h1><p>${detail}</p></div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}
