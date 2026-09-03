/**
 * Makes the collage-sized copy of a photo, in the browser, before upload.
 *
 * Why in the browser rather than server-side: Supabase edge functions run on
 * Deno with no native image library, so resizing there would mean shipping a
 * WASM decoder, and none of the practical ones handle HEIC — which is exactly
 * what an iPhone hands you. The phone already has decoders for everything its
 * own camera produces, so it is the right place to do this.
 *
 * Going through a canvas has two useful side effects:
 *  - EXIF orientation is baked into the pixels, so a photo taken sideways is
 *    upright in the collage without the renderer having to know anything.
 *  - all metadata is dropped, so the copy that lives in Supabase carries no
 *    GPS. The original keeps its EXIF and goes to Google Photos untouched.
 *
 * WebP is preferred over JPEG because it is materially smaller at the same
 * visual quality — measured on this project: ~35% smaller on high-detail
 * content like foliage or a crowd, and several times smaller on smooth content
 * like a sky or a portrait. Every browser that can decode a phone photo can
 * also encode WebP, but the fallback to JPEG is there because a silent failure
 * would mean uploading a PNG several times larger than the original.
 */

const FORMATS = {
  webp: "image/webp",
  jpeg: "image/jpeg",
};

let webpEncodable = null;

/** Cached one-off probe: does this browser encode WebP from a canvas? */
async function canEncodeWebp() {
  if (webpEncodable !== null) return webpEncodable;
  try {
    const canvas = makeCanvas(8, 8);
    canvas.getContext("2d");
    const blob = await toBlob(canvas, FORMATS.webp, 0.8);
    webpEncodable = blob?.type === FORMATS.webp;
  } catch {
    webpEncodable = false;
  }
  return webpEncodable;
}

/**
 * Returns { blob, width, height, mimeType }, or null if the browser has no
 * decoder for this file. Callers should treat null as "upload the original
 * anyway, but this photo cannot join the collage".
 */
export async function makeDisplayCopy(file, { maxEdge = 1920, quality = 0.8 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }

  try {
    // Only ever downscale. Upscaling a small photo would cost bytes and add
    // nothing a collage tile could show.
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;

    // Neither target format carries alpha; without this, a transparent PNG
    // turns black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const mimeType = (await canEncodeWebp()) ? FORMATS.webp : FORMATS.jpeg;
    const blob = await toBlob(canvas, mimeType, quality);

    // Guard against a browser that accepted the type but produced something
    // else (historically some returned PNG, which is far bigger).
    if (!blob || blob.type !== mimeType) {
      const fallback = await toBlob(canvas, FORMATS.jpeg, quality);
      if (!fallback) return null;
      return { blob: fallback, width, height, mimeType: FORMATS.jpeg };
    }

    return { blob, width, height, mimeType };
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
