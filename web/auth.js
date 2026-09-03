/**
 * Shared auth for both pages.
 *
 * The access key arrives in the URL *fragment* (`#k=...`). Fragments are never
 * sent to a server, so the key stays out of access logs, Referer headers and
 * CDN logs — unlike a querystring. We read it, exchange it for a session token,
 * then scrub it from the address bar so it does not end up in a screenshot or a
 * shoulder-surf. None of this needs a tap: a guest opens the link and lands
 * straight on the upload buttons.
 *
 * The session token is a bearer token rather than an HttpOnly cookie, because
 * this page is on github.io and the backend is on supabase.co: any cookie the
 * backend set would be a third-party cookie and blocked by default in Safari
 * and Firefox.
 *
 * The key itself goes in localStorage, not sessionStorage. Phones evict
 * background tabs aggressively, and a guest who reopens the page from their tab
 * list would otherwise land on "this page needs the full link" with no way
 * back. localStorage survives that. The derived token stays in sessionStorage.
 *
 * `realm` namespaces the stored key so the owner's view-only collage link and
 * the guests' upload link can both be open in one browser without overwriting
 * each other.
 */

const CFG = window.PHOTO_DROP_CONFIG;

export class AuthError extends Error {}

export function createAuth(realm) {
  const KEY_STORE = `photo-drop:key:${realm}`;
  const TOKEN_STORE = `photo-drop:token:${realm}`;

  function readKeyFromFragment() {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    return params.get("k") || params.get("key");
  }

  function accessKey() {
    const fromUrl = readKeyFromFragment();
    if (fromUrl) {
      try {
        localStorage.setItem(KEY_STORE, fromUrl);
      } catch { /* private mode with no storage: this session still works */ }
      history.replaceState(null, "", location.pathname + location.search);
      return fromUrl;
    }
    try {
      return localStorage.getItem(KEY_STORE);
    } catch {
      return null;
    }
  }

  async function exchangeKeyForToken(key) {
    const res = await fetch(`${CFG.functionsUrl}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        throw new AuthError("Too many attempts from this network. Wait a few minutes and reload.");
      }
      // A rejected key is worth forgetting, or every reload retries it and
      // eats into the rate limit.
      if (res.status === 401) {
        try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
      }
      throw new AuthError(body.error || "That link is not valid.");
    }

    try { sessionStorage.setItem(TOKEN_STORE, JSON.stringify(body)); } catch { /* ignore */ }
    return body;
  }

  /**
   * Resolves to { token, expiresAt, scopes }. Re-exchanges the key when the
   * token is missing or close to expiry, so a collage left running on a screen
   * for days never falls out of session.
   */
  async function session({ force = false } = {}) {
    const key = accessKey();
    if (!key) {
      throw new AuthError("This page needs the full link, including the part after the #.");
    }

    if (!force) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(TOKEN_STORE) ?? "null");
        // 2-minute margin so a request in flight cannot expire mid-flight.
        if (cached?.token && new Date(cached.expiresAt).getTime() - Date.now() > 120_000) {
          return cached;
        }
      } catch { /* fall through to a fresh exchange */ }
    }

    return await exchangeKeyForToken(key);
  }

  /** fetch() against a function, with the bearer token and one silent retry on 401. */
  async function api(path, options = {}, { retried = false } = {}) {
    const { token } = await session({ force: retried });

    const res = await fetch(`${CFG.functionsUrl}${path}`, {
      ...options,
      headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
    });

    if (res.status === 401 && !retried) {
      try { sessionStorage.removeItem(TOKEN_STORE); } catch { /* ignore */ }
      return api(path, options, { retried: true });
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }

    return res.status === 204 ? null : res.json();
  }

  return { session, api, accessKey };
}
