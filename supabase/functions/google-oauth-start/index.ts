/**
 * GET /google-oauth-start?setup_secret=...
 *
 * One-time (well, once-per-revocation) setup that you run in your own browser
 * while signed into the Google account that should own the album. Redirects to
 * the Google consent screen. Expect a "Google hasn't verified this app" warning
 * — that is normal for an unverified app requesting Photos scopes, and you are
 * the only person who will ever see it.
 */

import { safeEqual } from "../_shared/http.ts";
import { requireEnv } from "../_shared/env.ts";
import { GOOGLE_SCOPES } from "../_shared/google-photos.ts";
import { redirectUri, signState } from "../_shared/oauth-state.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const provided = url.searchParams.get("setup_secret") ?? "";
  if (!safeEqual(provided, requireEnv("SETUP_SECRET"))) {
    return new Response("unauthorised", { status: 401 });
  }

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", requireEnv("GOOGLE_CLIENT_ID"));
  auth.searchParams.set("redirect_uri", redirectUri());
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", GOOGLE_SCOPES);
  // offline + consent is what gets us a refresh token at all, and forces a
  // fresh one even if this account has already granted the app before.
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", await signState());

  return Response.redirect(auth.toString(), 302);
});
