/**
 * CORS + JSON response helpers.
 *
 * The frontend is served from GitHub Pages and the backend from
 * *.supabase.co, so every request is cross-origin. ALLOWED_ORIGINS is a
 * comma-separated allowlist, e.g.
 *   https://yourname.github.io,http://localhost:5173
 */

const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const ok = allowed.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : allowed[0] ?? "null",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function fail(req: Request, status: number, message: string, extra: Record<string, unknown> = {}) {
  return json(req, { error: message, ...extra }, status);
}

/**
 * Client IP, for rate limiting and audit.
 *
 * `cf-connecting-ip` first: Supabase fronts these functions with Cloudflare,
 * which sets that header itself and strips any the client sent, so it cannot
 * be forged.
 *
 * Falling back to X-Forwarded-For, take the RIGHTMOST entry, not the leftmost.
 * The header is a chain where each proxy appends; the leftmost value is
 * whatever the client claimed, so trusting it — as this used to — let anyone
 * defeat the rate limit by sending a different fake value each request, and
 * flood `auth_attempts` with fiction. The rightmost entry is the one the
 * nearest trusted proxy wrote.
 */
export function clientIp(req: Request): string {
  const direct = req.headers.get("cf-connecting-ip");
  if (direct) return direct.trim();

  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

/** Timing-safe string compare, for secrets we cannot look up by index. */
export function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
