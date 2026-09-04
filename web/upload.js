import { AuthError, createAuth } from "./auth.js";
import { makeDisplayCopy } from "./downscale.js";

const CFG = window.PHOTO_DROP_CONFIG;
const { api, session } = createAuth("upload");

const els = {
  locked: document.getElementById("locked"),
  lockedMessage: document.getElementById("lockedMessage"),
  ready: document.getElementById("ready"),
  queue: document.getElementById("queue"),
  summary: document.getElementById("summary"),
  camera: document.getElementById("cameraInput"),
  library: document.getElementById("libraryInput"),
  cameraBtn: document.getElementById("cameraBtn"),
  libraryBtn: document.getElementById("libraryBtn"),
  cameraFallback: document.getElementById("cameraFallback"),
  sizeHint: document.getElementById("sizeHint"),
};

const MAX_BYTES = CFG.maxUploadBytes ?? 50 * 1024 * 1024;
const CONCURRENCY = 2;

// HEIC/HEIF cannot be previewed in most browsers, so those rows get a glyph
// instead of a broken image. The file uploads fine either way.
const PREVIEWABLE = /^image\/(jpeg|png|webp|gif|avif)$/i;

function show(state) {
  for (const el of [els.locked, els.ready]) el.removeAttribute("data-active");
  state.setAttribute("data-active", "");
}

els.sizeHint.textContent =
  `JPEG, PNG, HEIC or WebP · up to ${Math.floor(MAX_BYTES / 1024 / 1024)} MB each`;

// --- boot -------------------------------------------------------------------

show(els.locked);

try {
  const { scopes } = await session();
  if (!scopes.includes("upload")) {
    els.lockedMessage.textContent = "This link cannot upload photos.";
  } else {
    show(els.ready);
  }
} catch (e) {
  els.lockedMessage.textContent = e instanceof AuthError
    ? e.message
    : "Could not reach the server. Check your connection and reload.";
}

els.camera.addEventListener("change", onPick);
els.library.addEventListener("change", onPick);

/**
 * Opening the picker from JS rather than a <label for>. Label-driven activation
 * of a hidden file input is unreliable on Android and in in-app WebViews, where
 * tapping simply does nothing. `input.click()` inside a real user gesture is
 * honoured everywhere.
 *
 * `capture` is only a hint, and a device with no camera app can leave the
 * picker unopened with no error to catch. If focus never leaves the page after
 * a camera tap, point the guest at the library button, which on Android
 * normally offers the camera anyway.
 */
function openPicker(input, { isCamera = false } = {}) {
  let opened = false;
  const markOpened = () => { opened = true; };
  addEventListener("blur", markOpened, { once: true });
  document.addEventListener("visibilitychange", markOpened, { once: true });

  try {
    input.click();
  } catch {
    if (isCamera) els.cameraFallback.hidden = false;
    return;
  }

  if (isCamera) {
    setTimeout(() => {
      removeEventListener("blur", markOpened);
      if (!opened && els.camera.files.length === 0) els.cameraFallback.hidden = false;
    }, 1500);
  }
}

els.cameraBtn.addEventListener("click", () => openPicker(els.camera, { isCamera: true }));
els.libraryBtn.addEventListener("click", () => openPicker(els.library));

function onPick(event) {
  const files = [...event.target.files];
  event.target.value = ""; // let the same file be picked again after a failure
  if (files.length) enqueue(files);
}

// --- queue ------------------------------------------------------------------

const pending = [];
let active = 0;
let succeeded = 0;
let failed = 0;

function enqueue(files) {
  for (const file of files) {
    const item = renderItem(file);
    if (file.size > MAX_BYTES) {
      setStatus(item, "error", `Too big (${mb(file.size)} MB). Max is 25 MB.`);
      failed++;
      continue;
    }
    if (!looksLikeImage(file)) {
      setStatus(item, "error", "Not an image file.");
      failed++;
      continue;
    }
    pending.push({ file, item });
  }
  updateSummary();
  pump();
}

function pump() {
  while (active < CONCURRENCY && pending.length) {
    const job = pending.shift();
    active++;
    upload(job)
      .then(() => { succeeded++; })
      .catch((e) => { failed++; setStatus(job.item, "error", e.message); })
      .finally(() => {
        active--;
        updateSummary();
        pump();
      });
  }
}

async function upload({ file, item }) {
  const contentType = normaliseType(file);

  setStatus(item, "working", "Preparing…");
  const display = await makeDisplayCopy(file, {
    maxEdge: CFG.displayMaxEdge ?? 1920,
    quality: CFG.displayQuality ?? 0.8,
  });

  const urls = await api("/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contentType,
      sizeBytes: file.size,
      displayType: display?.mimeType ?? null,
    }),
  });

  // Progress is weighted by bytes, and the original is the overwhelming
  // majority of them, so the bar tracks what the user is actually waiting for.
  const totalBytes = file.size + (display?.blob.size ?? 0);
  let uploaded = 0;
  const onChunk = (bytesForThisFile) => {
    setProgress(item, (uploaded + bytesForThisFile) / totalBytes);
  };

  // Small file first: if the connection is going to fail, find out before
  // spending several megabytes of someone's mobile data.
  if (display && urls.display) {
    setStatus(item, "working", "Uploading…");
    await putWithProgress(urls.display.signedUrl, display.blob, display.mimeType, onChunk);
    uploaded += display.blob.size;
  }

  setStatus(item, "working", "Uploading…");
  await putWithProgress(urls.original.signedUrl, file, contentType, onChunk);
  uploaded += file.size;

  setStatus(item, "working", "Finishing…");
  await api("/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      originalPath: urls.original.path,
      contentType,
      originalName: file.name,
      displayPath: display && urls.display ? urls.display.path : null,
      displayType: display?.mimeType ?? null,
      displayWidth: display?.width ?? null,
      displayHeight: display?.height ?? null,
    }),
  });

  setStatus(item, "done", display ? "Added" : "Added (not shown in the collage)");
  item.querySelector(".bar").hidden = true;
}

/**
 * Straight PUT to the Supabase Storage signed URL. XHR rather than fetch purely
 * because it reports upload progress, which matters a lot on a phone pushing a
 * 5 MB photo over mobile data.
 */
function putWithProgress(url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("content-type", contentType);
    // Let the browser cache the display copy hard once the collage fetches it.
    xhr.setRequestHeader("cache-control", "max-age=604800");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}). Try again.`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — connection dropped."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.timeout = 5 * 60 * 1000;
    xhr.send(body);
  });
}

function looksLikeImage(file) {
  return file.type.startsWith("image/") || normaliseType(file) !== "application/octet-stream";
}

/** iOS sometimes reports an empty type; fall back to the extension. */
function normaliseType(file) {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase();
  return {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", avif: "image/avif", gif: "image/gif",
  }[ext ?? ""] ?? "application/octet-stream";
}

// --- rendering --------------------------------------------------------------

function renderItem(file) {
  const li = document.createElement("li");
  li.className = "item";
  li.dataset.status = "queued";
  li.innerHTML = `
    <div class="thumb"></div>
    <div class="meta">
      <div class="name"></div>
      <div class="sub">Queued</div>
      <div class="bar"><span></span></div>
    </div>
    <div class="tick"></div>`;

  li.querySelector(".name").textContent = file.name || "photo";

  const thumb = li.querySelector(".thumb");
  if (PREVIEWABLE.test(file.type)) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    img.onerror = () => {
      const fallback = document.createElement("div");
      fallback.className = "thumb";
      fallback.textContent = "🖼";
      img.replaceWith(fallback);
    };
    thumb.replaceWith(img);
  } else {
    thumb.textContent = "🖼";
  }

  els.queue.prepend(li);
  return li;
}

function setStatus(item, status, text) {
  item.dataset.status = status;
  const sub = item.querySelector(".sub");
  sub.textContent = text;
  sub.classList.toggle("err", status === "error");
  item.querySelector(".tick").textContent =
    status === "done" ? "✓" : status === "error" ? "!" : "";
  if (status === "error") item.querySelector(".bar").hidden = true;
}

function setProgress(item, fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  item.querySelector(".bar > span").style.width = `${Math.round(clamped * 100)}%`;
}

function updateSummary() {
  const inFlight = active + pending.length;
  const parts = [];
  if (succeeded) parts.push(`${succeeded} added`);
  if (inFlight) parts.push(`${inFlight} to go`);
  if (failed) parts.push(`${failed} failed`);
  els.summary.textContent = parts.join(" · ");
  els.summary.hidden = parts.length === 0;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

// A phone that navigates away mid-upload loses the photo silently. iOS honours
// this inconsistently, but where it works it saves someone's upload.
addEventListener("beforeunload", (e) => {
  if (active + pending.length === 0) return;
  e.preventDefault();
  e.returnValue = "";
});
