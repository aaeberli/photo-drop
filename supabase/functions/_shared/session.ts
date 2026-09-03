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

/**
 * Type predicate, so callers get a non-null `session` after the guard and can
 * reach `keyId` without an assertion.
 */
export function hasScope(session: Session | null, scope: Scope): session is Session {
  return !!session && session.scopes.includes(scope);
}

/** sha256(key || pepper), hex. The plaintext key is never stored. */
export async function hashAccessKey(key: string): Promise<string> {
  const pepper = requireEnv("AUTH_KEY_PEPPER");
  const bytes = new TextEncoder().encode(`${key}${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
