// Fill in your Supabase project ref. Nothing secret belongs in this file — it
// is served publicly from GitHub Pages.
window.PHOTO_DROP_CONFIG = {
  functionsUrl: "https://YOUR_PROJECT_REF.supabase.co/functions/v1",

  // Collage behaviour
  collageIntervalMs: 60_000, // how often the layout reshuffles

  // --- the display copy the browser generates before upload ---------------
  //
  // This is what the collage renders. The original goes to Google Photos
  // untouched, so nothing here affects your archive — only how much Supabase
  // storage the collage costs and how sharp the biggest tile looks.
  //
  // 1920 is not a guess. The largest tile in the mosaic templates spans 2 of 4
  // columns, so it is exactly 1920 CSS px wide on a 3840px 4K screen — a 1920
  // copy fills it pixel for pixel. A 1080p screen has plenty to spare.
  //
  // Measured cost per 12 MP phone photo, WebP at this quality:
  //   smooth (sky, portrait)      ~30-80 KB
  //   typical scene               ~100-250 KB
  //   busy (foliage, a crowd)     ~250-400 KB
  // Call it ~250 KB average, so the 1 GB free tier holds roughly 4,000 photos.
  //
  // Raise maxEdge to 2560 only if the collage runs on a high-dpr desktop
  // monitor at desk distance, where the big tile wants 2x density. That costs
  // about 2.5x the storage. Anything above 2560 buys nothing on any screen.
  displayMaxEdge: 1920,
  displayQuality: 0.8,
};
