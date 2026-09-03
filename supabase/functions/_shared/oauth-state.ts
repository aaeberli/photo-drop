/**
 * Short-lived signed `state` for the Google OAuth round trip. Stateless CSRF
 * protection: only google-oauth-start can mint one, and it is valid for long
 * enough to click through Google's consent screens.
 */

import { SignJWT, decodeJwt, jwtVerify } from "npm:jose@5.9.6";
import { requireEnv } from "./env.ts";

const RAW_SECRET = requireEnv("SESSION_JWT_SECRET");
const SECRET = new TextEncoder().encode(RAW_SECRET);
const ISSUER = "photo-drop-oauth";

/**
 * Generous on purpose. This is a one-time setup flow that in practice involves
 * switching Google accounts and clicking past an "unverified app" warning, so a
 * short window fails for reasons that have nothing to do with CSRF. The
 * endpoint that mints these is already behind SETUP_SECRET.
 */
const TTL_SECONDS = 30 * 60;

/**
 * First 8 hex of sha256(secret). Safe to expose — it cannot be reversed — and
 * it lets the callback tell "someone forged this" apart from "start and
 * callback are running with different SESSION_JWT_SECRET values", which is
 * otherwise indistinguishable and by far the more likely of the two.
 */
async function secretFingerprint(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RAW_SECRET));
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signState(): Promise<string> {
  return await new SignJWT({ nonce: crypto.randomUUID(), sfp: await secretFingerprint() })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + TTL_SECONDS)
    .sign(SECRET);
}

export type StateResult = { ok: true } | { ok: false; reason: string };

export async function verifyState(state: string | null): Promise<StateResult> {
  if (!state) return { ok: false, reason: "No state parameter came back in the callback." };

  try {
    await jwtVerify(state, SECRET, {
      issuer: ISSUER,
      audience: ISSUER,
      algorithms: ["HS256"],
    });
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e as Error).name ?? "unknown";
    const message = e instanceof Error ? e.message : String(e);

    // Signature failures are ambiguous, so pull the fingerprint out of the
    // unverified payload and say which of the two it actually was.
    let detail = "";
    try {
      const claims = decodeJwt(state) as { sfp?: string };
      const mine = await secretFingerprint();
      if (claims.sfp && claims.sfp !== mine) {
        detail =
          ` The state was signed with a different SESSION_JWT_SECRET` +
          ` (signed by ${claims.sfp}, this worker has ${mine}).` +
          ` Redeploy both google-oauth functions so they pick up the same value,` +
          ` then start again.`;
      } else if (claims.sfp) {
        detail = ` Secret matches (${mine}), so this is not a secret mismatch.`;
      } else {
        // `sfp` has been minted since this diagnostic was added, so a state
        // without one predates the running deployment.
        detail =
          " This state was minted by an older deployment, which means you are" +
          " re-opening a stale callback URL rather than starting a new flow." +
          " Open google-oauth-start again and let Google redirect you;" +
          " the authorization code in a used callback URL is single-use.";
      }
    } catch {
      detail = " The state parameter is not a readable JWT — it was altered in transit.";
    }

    console.error(`state verification failed: ${code} ${message}${detail}`);
    return { ok: false, reason: `${code}. ${message}.${detail}` };
  }
}

/** The exact URI that must be registered on the Google OAuth client. */
export function redirectUri(): string {
  const override = Deno.env.get("GOOGLE_REDIRECT_URI");
  if (override) return override;
  return `${requireEnv("SUPABASE_URL")}/functions/v1/google-oauth-callback`;
}
