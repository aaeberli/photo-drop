import { AuthError, createAuth } from "./auth.js";

const CFG = window.PHOTO_DROP_CONFIG;
const INTERVAL = CFG.collageIntervalMs ?? 60_000;
const { api, session } = createAuth("view");

const els = {
  stage: document.getElementById("stage"),
  layers: [document.getElementById("layerA"), document.getElementById("layerB")],
  message: document.getElementById("message"),
  messageText: document.getElementById("messageText"),
  overlay: document.getElementById("overlay"),
  status: document.getElementById("status"),
  shuffle: document.getElementById("shuffleBtn"),
  fullscreen: document.getElementById("fullscreenBtn"),
};

/**
 * Mosaic templates as CSS grid areas. Each distinct letter is one tile, and
 * every letter must form a rectangle. Picked by screen aspect ratio so a phone
 * held upright and a TV both get a sensible layout.
 */
const TEMPLATES = {
  landscape: [
    ["a a b c", "a a d e", "f g h e"],
    ["a b b c", "d b b c", "e f g h"],
    ["a a b c d", "a a e f d", "g h i f d"],
    ["a b b c d", "e b b f d", "g h i j d"],
  ],
  wide: [
    ["a a b c d d", "a a e c d d", "f g h i j k", "f l h i j k"],
    ["a a b c c d", "a a b e f d", "g h i e f j", "g h i k k j"],
  ],
  portrait: [
    ["a a", "b c", "d d", "e f"],
    ["a a b", "a a c", "d e f", "g h i"],
    ["a a", "b c", "d e"],
  ],
};

function pickTemplate(available) {
  const { innerWidth: w, innerHeight: h } = window;
  const ratio = w / h;
  const pool = ratio < 0.9
    ? TEMPLATES.portrait
    : ratio > 1.9 && w >= 1400
      ? [...TEMPLATES.wide, ...TEMPLATES.landscape]
      : TEMPLATES.landscape;

  // Never ask for more tiles than we have photos: a repeated photo in the same
  // frame is far more noticeable than a coarser grid.
  const usable = pool.filter((t) => tileCount(t) <= available);
  const chosen = usable.length ? usable : [pool.reduce((a, b) => (tileCount(a) <= tileCount(b) ? a : b))];
  return chosen[Math.floor(Math.random() * chosen.length)];
}

function tileCount(template) {
  return new Set(template.join(" ").split(/\s+/).filter(Boolean)).size;
}

// --- photo selection --------------------------------------------------------

let photos = [];
let bag = [];          // shuffle bag, so every photo gets shown before repeats
let shownIds = new Set();

function refillBag() {
  bag = photos.map((p) => p.id);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
}

function selectPhotos(count) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const picked = [];

  // A photo uploaded in the last few minutes jumps the queue, so someone who
  // just took a picture sees it appear on the next reshuffle.
  const fresh = photos
    .filter((p) => p.createdAt && Date.now() - new Date(p.createdAt).getTime() < 5 * 60_000)
    .filter((p) => !shownIds.has(p.id))
    .slice(0, Math.max(1, Math.floor(count / 3)));
  picked.push(...fresh);

  while (picked.length < count) {
    if (bag.length === 0) {
      refillBag();
      shownIds = new Set();
      if (bag.length === 0) break;
    }
    const id = bag.pop();
    if (picked.some((p) => p.id === id)) continue;
    const photo = byId.get(id);
    if (photo) picked.push(photo);
  }

  for (const p of picked) shownIds.add(p.id);
  return picked;
}

// --- rendering --------------------------------------------------------------

let visibleLayer = 0;

function buildLayer(layer, template, selected) {
  const cols = template[0].trim().split(/\s+/).length;
  const rows = template.length;
  layer.style.gridTemplateAreas = template.map((r) => `"${r}"`).join(" ");
  layer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  layer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  layer.replaceChildren();

  const letters = [...new Set(template.join(" ").split(/\s+/).filter(Boolean))];
  const images = [];

  letters.forEach((letter, i) => {
    const photo = selected[i % selected.length];
    const figure = document.createElement("figure");
    figure.style.gridArea = letter;

    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    // /photos returns the same signed url on every poll, so after the first
    // load every tile comes out of the browser cache.
    img.src = photo.url;
    figure.appendChild(img);
    layer.appendChild(figure);
    images.push(img);
  });

  return images;
}

/** Resolves once every image has loaded, or after a 12s cap. */
function waitForImages(images) {
  const settled = images.map(
    (img) =>
      new Promise((resolve) => {
        if (img.complete && img.naturalWidth > 0) return resolve();
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      }),
  );
  return Promise.race([
    Promise.all(settled),
    new Promise((resolve) => setTimeout(resolve, 12_000)),
  ]);
}

async function reshuffle() {
  if (photos.length === 0) return;

  const template = pickTemplate(photos.length);
  const selected = selectPhotos(tileCount(template));
  if (selected.length === 0) return;

  const next = (visibleLayer + 1) % 2;
  const images = buildLayer(els.layers[next], template, selected);

  // Preload before the crossfade, otherwise the incoming layer fades in as a
  // grid of empty boxes.
  await waitForImages(images);

  els.layers[next].classList.add("visible");
  els.layers[visibleLayer].classList.remove("visible");
  visibleLayer = next;
}

// --- data -------------------------------------------------------------------

async function refresh() {
  const data = await api("/photos");
  const ids = new Set(photos.map((p) => p.id));
  const added = data.photos.filter((p) => !ids.has(p.id)).length;

  photos = data.photos;
  // Drop ids for photos that have since been removed, but keep the rest of the
  // bag so newly-arrived photos do not reset everyone's rotation.
  bag = bag.filter((id) => photos.some((p) => p.id === id));

  setStatus(`${photos.length} photo${photos.length === 1 ? "" : "s"}` +
            (added ? ` · ${added} new` : ""));
  return added;
}

function setStatus(text) {
  els.status.textContent = text;
}

function showMessage(text) {
  els.messageText.textContent = text;
  els.message.style.display = "grid";
}

function hideMessage() {
  els.message.style.display = "none";
}

// --- boot -------------------------------------------------------------------

try {
  const { scopes } = await session();
  if (!scopes.includes("view")) throw new AuthError("This link cannot view the collage.");

  await refresh();
  if (photos.length === 0) {
    showMessage("No photos in the album yet. As soon as someone uploads one it will show up here.");
  } else {
    hideMessage();
    await reshuffle();
  }
} catch (e) {
  showMessage(
    e instanceof AuthError
      ? e.message
      : `Could not load the album: ${e.message}`,
  );
}

// One timer drives both: pull the latest list, then re-lay-out. A photo appears
// here within a minute of someone uploading it, because /photos reads the
// display copies in Storage and does not wait for the Google Photos mirror.
setInterval(async () => {
  if (document.hidden) return; // a backgrounded tab does not need to churn
  try {
    await refresh();
    if (photos.length === 0) {
      showMessage("No photos in the album yet.");
      return;
    }
    hideMessage();
    await reshuffle();
  } catch (e) {
    setStatus(`Update failed: ${e.message}`);
  }
}, INTERVAL);

// A tab that was hidden for a while has missed reshuffles; catch up on return.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  try {
    await refresh();
    if (photos.length) {
      hideMessage();
      await reshuffle();
    }
  } catch { /* the interval will retry */ }
});

els.shuffle.addEventListener("click", () => reshuffle());

els.fullscreen.addEventListener("click", async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen().catch(() => {});
    keepAwake();
  }
});

// Keep a wall display from sleeping. Not supported everywhere; harmless if not.
async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden && lock?.released) await navigator.wakeLock.request("screen");
    });
  } catch { /* no wake lock available */ }
}
keepAwake();

// Tap anywhere on a touch screen to reveal the controls briefly.
els.stage.addEventListener("pointerdown", () => {
  els.overlay.classList.add("pinned");
  setTimeout(() => els.overlay.classList.remove("pinned"), 4000);
});
