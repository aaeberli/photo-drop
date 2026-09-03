/**
 * POST /auth  { key }  ->  { token, expiresAt, scopes }
 *
 * The key arrives from the link's URL *fragment* (never the querystring), so it
 * has not been written to any access log, browser history entry or Referer
 * header on the way here.
 */

import { clientIp, fail, json, preflight } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { hashAccessKey, issueToken, type Scope } from "../_shared/session.ts";

const WINDOW_MINUTES = 10;
const MAX_FAILURES_PER_WINDOW = 10;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, 405, "method not allowed");

  const ip = clientIp(req);
  const supabase = db();

  let key: unknown;
  try {
    key = (await req.json()).key;
  } catch {
    return fail(req, 400, "expected a JSON body");
  }
  if (typeof key !== "string" || key.length < 8 || key.length > 200) {
    await supabase.from("auth_attempts").insert({ ip, ok: false });
    return fail(req, 400, "invalid key");
  }

  // Rate limit on failures only, so a shared key in heavy legitimate use by a
  // group of people behind one NAT does not lock itself out.
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await supabase
    .from("auth_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .eq("ok", false)
    .gte("at", since);

  if ((count ?? 0) >= MAX_FAILURES_PER_WINDOW) {
    return fail(req, 429, "too many attempts, try again later", {
      retryAfterSeconds: WINDOW_MINUTES * 60,
    });
  }

  const keyHash = await hashAccessKey(key.trim());
  const { data: row, error } = await supabase
    .from("access_keys")
    .select("id, scopes, revoked, expires_at")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (error) {
    console.error("access_keys lookup failed", error);
    return fail(req, 500, "internal error");
  }

  const expired = row?.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
  if (!row || row.revoked || expired) {
    await supabase.from("auth_attempts").insert({ ip, ok: false });
    // Same response for unknown / revoked / expired: no oracle for the caller.
    return fail(req, 401, "That link is not valid.");
  }

  await Promise.all([
    supabase.from("auth_attempts").insert({ ip, ok: true }),
    supabase.from("access_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id),
  ]);

  const scopes = (row.scopes ?? []) as Scope[];
  const { token, expiresAt } = await issueToken({ keyId: row.id, scopes });
  return json(req, { token, expiresAt, scopes });
});
