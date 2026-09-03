/**
 * Env access. Separate from session.ts so importing the Google client or the db
 * client does not drag in a hard requirement for SESSION_JWT_SECRET.
 */

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function numEnv(name: string, fallback: number): number {
  const v = Deno.env.get(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
