#!/usr/bin/env node
/**
 * Local dev server: serves web/ and a stand-in for the edge functions, so both
 * pages can be exercised without touching Supabase or Google.
 *
 *   node scripts/dev-mock.mjs
 *
 * Uploaded display copies are held in memory and served back, so the collage
 * shows the photos you actually upload — which is the only way to check that
 * downscaling, EXIF orientation baking and the two-PUT flow really work.
 *
 * Two keys, mirroring production scope split:
 *   GUEST-KEY  upload only
 *   OWNER-KEY  view only
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = normalize(join(fileURLToPath(import.meta.url), "..", "..", "web"));
const PORT = Number(process.env.PORT ?? 8787);
const SEED_PHOTOS = Number(process.env.MOCK_PHOTOS ?? 12);

const KEYS = {
  "GUEST-KEY": ["upload"],
  "OWNER-KEY": ["view"],
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// --- state -----------------------------------------------------------------

/** path -> { bytes, contentType } for both buckets. */
const objects = new Map();
/** the photos ledger, newest last. */
const photos = [];
let seedCount = SEED_PHOTOS;
/** Stands in for the DISPLAY_BUDGET_BYTES guard. Toggle: /mock-control?full=1 */
let storageFull = false;

function seedSvg(index) {
  const hue = Math.round((360 / Math.max(1, SEED_PHOTOS)) * index);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 65% 55%)"/>
    <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 70% 30%)"/>
  </linearGradient></defs>
  <rect width="400" height="400" fill="url(#g)"/>
  <text x="200" y="230" font-family="system-ui" font-size="140" font-weight="700"
        fill="rgba(255,255,255,.85)" text-anchor="middle">${index + 1}</text>
</svg>`,
  );
}

function seedPhotos() {
  for (let i = 0; i < seedCount; i++) {
    const path = `seed/${i}.svg`;
    objects.set(`display/${path}`, { bytes: seedSvg(i), contentType: "image/svg+xml" });
    photos.push({
      id: `seed-${i}`,
      displayPath: path,
      width: 400,
      height: 400,
      createdAt: new Date(Date.now() - (seedCount - i) * 3600_000).toISOString(),
    });
  }
}
seedPhotos();

// --- helpers ---------------------------------------------------------------

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, cache-control",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    ...headers,
  });
  res.end(body);
};

const sendJson = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { "content-type": "application/json" });

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

/** Returns the granted scopes, or null. Tokens are `mock.<scopes>.<ts>`. */
function scopesFor(req) {
  const m = (req.headers.authorization ?? "").match(/^Bearer mock\.([a-z,]*)\./);
  return m ? m[1].split(",").filter(Boolean) : null;
}

const uuid = () => crypto.randomUUID();

// --- server ----------------------------------------------------------------

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return send(res, 204, "");

  // --- mock edge functions -------------------------------------------------
  if (path === "/functions/v1/auth") {
    const { key } = JSON.parse((await readBody(req)).toString() || "{}");
    const scopes = KEYS[key];
    if (!scopes) {
      console.log(`  auth        rejected ${JSON.stringify(key)}`);
      return sendJson(res, 401, { error: "That link is not valid." });
    }
    console.log(`  auth        ok, scopes=${scopes.join(",")}`);
    return sendJson(res, 200, {
      token: `mock.${scopes.join(",")}.${Date.now()}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes,
    });
  }

  if (path === "/functions/v1/upload-url") {
    if (!scopesFor(req)?.includes("upload")) {
      return sendJson(res, 401, { error: "not authorised to upload" });
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (storageFull) {
      return sendJson(res, 507, { error: "The album is full. Ask the organiser to make room." });
    }
    const id = uuid();
    const ext = (body.contentType ?? "image/jpeg").split("/")[1].replace("jpeg", "jpg");
    const originalPath = `2026/08/${id}.${ext}`;
    const displayExt = { "image/webp": "webp", "image/jpeg": "jpg" }[body.displayType];
    console.log(
      `  upload-url  ${body.contentType}, ${body.sizeBytes} bytes, display=${body.displayType ?? "none"}`,
    );
    return sendJson(res, 200, {
      original: {
        path: originalPath,
        signedUrl: `http://localhost:${PORT}/mock-storage/uploads/${originalPath}`,
      },
      display: displayExt ? {
        path: `2026/08/${id}.${displayExt}`,
        signedUrl: `http://localhost:${PORT}/mock-storage/display/2026/08/${id}.${displayExt}`,
      } : null,
    });
  }

  if (path.startsWith("/mock-storage/") && req.method === "PUT") {
    const key = path.slice("/mock-storage/".length);
    const bytes = await readBody(req);
    objects.set(key, { bytes, contentType: req.headers["content-type"] ?? "application/octet-stream" });
    // Simulate a slow mobile link so the progress bar is observable.
    await new Promise((r) => setTimeout(r, 300));
    console.log(`  storage PUT ${key} (${bytes.length} bytes)`);
    return send(res, 200, "");
  }

  if (path === "/functions/v1/commit") {
    if (!scopesFor(req)?.includes("upload")) {
      return sendJson(res, 401, { error: "not authorised to upload" });
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (!objects.has(`uploads/${body.originalPath}`)) {
      return sendJson(res, 409, { error: "upload not found — retry the upload" });
    }
    if (body.displayPath && !objects.has(`display/${body.displayPath}`)) {
      return sendJson(res, 409, { error: "display copy not found — retry the upload" });
    }
    const id = uuid();
    if (body.displayPath) {
      photos.push({
        id,
        displayPath: body.displayPath,
        width: body.displayWidth,
        height: body.displayHeight,
        createdAt: new Date().toISOString(),
      });
    }
    // The real sync worker mirrors the original to Google then deletes it.
    const originalKB = Math.round(objects.get(`uploads/${body.originalPath}`).bytes.length / 1024);
    const displayKB = Math.round((objects.get(`display/${body.displayPath}`)?.bytes.length ?? 0) / 1024);
    objects.delete(`uploads/${body.originalPath}`);
    console.log(
      `  commit      ${body.originalName}: original ${originalKB} KB -> ` +
        `${body.displayType} ${body.displayWidth}x${body.displayHeight} ${displayKB} KB ` +
        `(${Math.round((1 - displayKB / originalKB) * 100)}% smaller)`,
    );
    return sendJson(res, 200, { id, inCollage: !!body.displayPath });
  }

  if (path === "/functions/v1/photos") {
    if (!scopesFor(req)?.includes("view")) {
      return sendJson(res, 401, { error: "not authorised to view" });
    }
    const list = [...photos].reverse().map((p) => ({
      id: p.id,
      // Stable url, like the cached signed urls in production.
      url: `http://localhost:${PORT}/mock-display/${p.displayPath}`,
      width: p.width,
      height: p.height,
      createdAt: p.createdAt,
    }));
    return sendJson(res, 200, { photos: list, count: list.length });
  }

  if (path.startsWith("/mock-display/")) {
    const object = objects.get(`display/${path.slice("/mock-display/".length)}`);
    if (!object) return send(res, 404, "not found");
    return send(res, 200, object.bytes, {
      "content-type": object.contentType,
      "cache-control": "max-age=604800",
    });
  }

  // Runtime knob so states like "empty album" can be checked without a restart.
  if (path === "/mock-control") {
    if (url.searchParams.get("full") !== null) {
      storageFull = url.searchParams.get("full") === "1";
      console.log(`  mock-control  storageFull=${storageFull}`);
    }
    if (url.searchParams.get("clear") !== null) {
      photos.length = 0;
      console.log("  mock-control  cleared");
    }
    if (url.searchParams.get("seed") !== null) {
      photos.length = 0;
      seedCount = Number(url.searchParams.get("seed")) || SEED_PHOTOS;
      seedPhotos();
      console.log(`  mock-control  seeded ${photos.length}`);
    }
    return sendJson(res, 200, { photos: photos.length, storageFull });
  }

  // --- static files --------------------------------------------------------
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");

  try {
    let content = await readFile(file);
    const origin = `http://localhost:${PORT}`;

    if (rel === "config.js") {
      content = content
        .toString()
        .replace("https://YOUR_PROJECT_REF.supabase.co/functions/v1", `${origin}/functions/v1`);
    }

    // Widen the pages' CSP just enough to reach this server. Production keeps
    // the tight policy that ships in the HTML.
    if (extname(file) === ".html") {
      content = content
        .toString()
        .replace("connect-src https://*.supabase.co", `connect-src ${origin}`)
        .replace(/img-src ([^;]+)/, `img-src $1 ${origin}`);
    }

    return send(res, 200, content, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
  } catch {
    return send(res, 404, "not found");
  }
}).listen(PORT, () => {
  console.log(`
photo-drop dev mock on http://localhost:${PORT}

  guest upload   http://localhost:${PORT}/#k=GUEST-KEY
  owner collage  http://localhost:${PORT}/collage.html#k=OWNER-KEY
  bad key        http://localhost:${PORT}/#k=WRONG
  empty album    http://localhost:${PORT}/mock-control?clear
  reseed         http://localhost:${PORT}/mock-control?seed=12
  storage full   http://localhost:${PORT}/mock-control?full=1
`);
});
