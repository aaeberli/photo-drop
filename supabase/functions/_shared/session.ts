/**
 * Session tokens.
 *
 * The share link carries a high-entropy access key. /auth exchanges it for one
 * of these: an HS256 JWT signed with SESSION_JWT_SECRET.
 *
 * Deliberately NOT signed with the project's Supabase JWT secret and carrying
 * no `role` claim — if it were, this token would also be a valid credential
 * against the Supabase REST API, which is exactly what we do not want to hand
 * to a guest's phone.
 */

import { SignJWT, jwtVerify } from "npm:jose@5.9.6";
import { numEnv, requireEnv } from "./env.ts";
import { db } from "./db.ts";

const SECRET = new TextEncoder().encode(requireEnv("SESSION_JWT_SECRET"));
const ISSUER = "photo-drop";
const TTL_SECONDS = numEnv("SESSION_TTL_SECONDS", 60 * 60 * 12);

export type Scope = "upload" | "view";

export interface Session {
  keyId: string;
  scopes: Scope[];
}

export async function issueToken(session: Session): Promise<{ token: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = await new SignJWT({ scopes: session.scopes })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setSubject(session.keyId)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(SECRET);

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Returns the session, or null if the bearer token is missing/invalid/expired. */
export async function readSession(req: Request): Promise<Session | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  try {
    const { payload } = await jwtVerify(m[1], SECRET, {
      issuer: ISSUER,
      audience: ISSUER,
      algorithms: ["HS256"],
    });
    const scopes = Array.isArray(payload.scopes) ? (payload.scopes as Scope[]) : [];
    if (!payload.sub) return null;
    return { keyId: payload.sub, scopes };
  } catch {
    return null;
  }
}

export type AuthResult =
  | { ok: true; session: Session }
  | { ok: false; status: number; error: string };

/**
 * The authorisation check for every endpoint except /auth.
 *
 * Verifying the JWT alone is not enough. A session token stays
 * cryptographically valid until it expires — SESSION_TTL_SECONDS, 12 hours by
 * default — so setting `revoked = true` on a key would stop it minting *new*
 * sessions while leaving anyone already holding one with a working credential
 * for the rest of the day. "Revoke" has to mean revoke.
 *
 * So the key is re-read on every request. That costs one indexed primary-key
 * lookup, which at this traffic level is nothing: the collage polls once a
 * minute per screen. In exchange, revoking a link takes effect on its next
 * request rather than up to twelve hours later.
 */
export async function requireSession(req: Request, scope: Scope): Promise<AuthResult> {
  const session = await readSession(req);
  if (!session) return { ok: false, status: 401, error: "Not signed in." };

  if (!session.scopes.includes(scope)) {
    // 403, not 401: the token is genuine, it simply does not carry this right,
    // so the client must not retry the exchange.
    return { ok: false, status: 403, error: `This link cannot ${scope} photos.` };
  }

  const { data, error } = await db()
    .from("access_keys")
    .select("revoked, expires_at")
    .eq("id", session.keyId)
    .maybeSingle();

  if (error) {
    // Fail closed, but with a status that reads as transient so the client
    // retries rather than discarding a perfectly good stored key.
    console.error("access_keys re-check failed", error);
    return { ok: false, status: 503, error: "Could not verify your link. Try again." };
  }

  // 401 on each of these is deliberate: the browser retries once against
  // /auth, that rejection clears the stored key, and the page stops working
  // cleanly instead of looping.
  if (!data) return { ok: false, status: 401, error: "That link no longer exists." };
  if (data.revoked) return { ok: false, status: 401, error: "That link has been revoked." };
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, error: "That link has expired." };
  }

  return { ok: true, session };
}

/** sha256(key || pepper), hex. The plaintext key is never stored. */
export async function hashAccessKey(key: string): Promise<string> {
  const pepper = requireEnv("AUTH_KEY_PEPPER");
  const bytes = new TextEncoder().encode(`${key}${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
