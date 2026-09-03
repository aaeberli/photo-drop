/**
 * Short-lived signed `state` for the Google OAuth round trip. Stateless CSRF
 * protection: only google-oauth-start can mint one, and it is valid for 10
 * minutes, which is all the time the consent screen needs.
 */

import { SignJWT, jwtVerify } from "npm:jose@5.9.6";
import { requireEnv } from "./env.ts";

const SECRET = new TextEncoder().encode(requireEnv("SESSION_JWT_SECRET"));
const ISSUER = "photo-drop-oauth";

export async function signState(): Promise<string> {
  return await new SignJWT({ nonce: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(SECRET);
}

export async function verifyState(state: string | null): Promise<boolean> {
  if (!state) return false;
  try {
    await jwtVerify(state, SECRET, {
      issuer: ISSUER,
      audience: ISSUER,
      algorithms: ["HS256"],
    });
    return true;
  } catch {
    return false;
  }
}

/** The exact URI that must be registered on the Google OAuth client. */
export function redirectUri(): string {
  const override = Deno.env.get("GOOGLE_REDIRECT_URI");
  if (override) return override;
  return `${requireEnv("SUPABASE_URL")}/functions/v1/google-oauth-callback`;
}
