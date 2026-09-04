/**
 * POST /sweep-orphans      (header: x-cron-secret)
 *
 * Deletes bytes that were uploaded but never committed.
 *
 * Without this, anyone holding the guest link could request signed upload URLs,
 * PUT files, never call /commit, and leave the bytes in the `uploads` bucket
 * forever — invisible to the storage budget, which only sums committed rows.
 *
 * Deliberately paranoid about what it deletes. It works from `upload_grants`
 * (uncommitted, past a grace period) but then re-checks `photos` for either
 * path before removing anything. The `committed` flag is set by /commit on a
 * best-effort basis, so trusting it alone could delete a live photo's display
 * copy — which would be a data-loss bug far worse than the storage leak this
 * is meant to fix.
 */

import { fail, json, safeEqual } from "../_shared/http.ts";
import { db, DISPLAY_BUCKET, UPLOAD_BUCKET } from "../_shared/db.ts";
import { numEnv, requireEnv } from "../_shared/env.ts";

/** How long an upload may sit uncommitted before it is considered abandoned. */
const GRACE_MINUTES = numEnv("ORPHAN_GRACE_MINUTES", 60);
const BATCH_SIZE = numEnv("ORPHAN_BATCH_SIZE", 200);

interface Grant {
  id: string;
  original_path: string;
  display_path: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(req, 405, "method not allowed");
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", requireEnv("CRON_SECRET"))) {
    return fail(req, 401, "unauthorised");
  }

  const supabase = db();

  const { data, error } = await supabase.rpc("orphaned_grants", {
    grace_minutes: GRACE_MINUTES,
    batch_size: BATCH_SIZE,
  });
  if (error) {
    console.error("orphaned_grants failed", error);
    return fail(req, 500, "could not list orphans");
  }

  const grants = (data ?? []) as Grant[];
  if (grants.length === 0) return json(req, { checked: 0, deleted: 0, reclaimed: 0 });

  // One query instead of one per grant.
  const originals = grants.map((g) => g.original_path);
  const displays = grants.map((g) => g.display_path).filter((p): p is string => !!p);

  // Two `.in()` queries rather than one `.or()`: PostgREST's filter grammar
  // treats `.` as the column/operator separator, and these paths are full of
  // dots. Letting supabase-js encode each `in` list is the safe route.
  const [byOriginal, byDisplay] = await Promise.all([
    supabase.from("photos").select("original_path, display_path").in("original_path", originals),
    displays.length
      ? supabase.from("photos").select("original_path, display_path").in("display_path", displays)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (byOriginal.error || byDisplay.error) {
    // Fail closed. Deleting on an incomplete picture risks removing live
    // photos, which is strictly worse than leaving the bytes another hour.
    console.error("live-photo check failed, skipping this sweep", byOriginal.error ?? byDisplay.error);
    return fail(req, 503, "could not verify which uploads are live");
  }

  const live = new Set<string>();
  for (const row of [...(byOriginal.data ?? []), ...(byDisplay.data ?? [])]) {
    if (row.original_path) live.add(row.original_path);
    if (row.display_path) live.add(row.display_path);
  }

  const toRemoveOriginals: string[] = [];
  const toRemoveDisplays: string[] = [];
  const orphanIds: string[] = [];
  const reconciledIds: string[] = [];

  for (const g of grants) {
    const referenced = live.has(g.original_path) ||
      (g.display_path !== null && live.has(g.display_path));

    if (referenced) {
      // A committed photo whose grant flag never got set. Fix the flag, keep
      // the bytes.
      reconciledIds.push(g.id);
      continue;
    }

    toRemoveOriginals.push(g.original_path);
    if (g.display_path) toRemoveDisplays.push(g.display_path);
    orphanIds.push(g.id);
  }

  let reclaimed = 0;
  if (toRemoveOriginals.length > 0) {
    const { data: removed, error: rmError } = await supabase
      .storage.from(UPLOAD_BUCKET)
      .remove(toRemoveOriginals);
    if (rmError) console.warn("removing staged originals failed", rmError.message);
    reclaimed += removed?.length ?? 0;
  }
  if (toRemoveDisplays.length > 0) {
    const { data: removed, error: rmError } = await supabase
      .storage.from(DISPLAY_BUCKET)
      .remove(toRemoveDisplays);
    if (rmError) console.warn("removing orphaned display copies failed", rmError.message);
    reclaimed += removed?.length ?? 0;
  }

  // Drop the grant rows only after the objects are gone, so a failure here
  // just means the next sweep retries rather than losing track of the bytes.
  if (orphanIds.length > 0) {
    const { error: delError } = await supabase.from("upload_grants").delete().in("id", orphanIds);
    if (delError) console.warn("deleting orphan grants failed", delError.message);
  }
  if (reconciledIds.length > 0) {
    await supabase.from("upload_grants").update({ committed: true }).in("id", reconciledIds);
  }

  console.log(
    `sweep: ${grants.length} checked, ${orphanIds.length} orphaned, ` +
      `${reconciledIds.length} reconciled, ${reclaimed} objects removed`,
  );

  return json(req, {
    checked: grants.length,
    orphaned: orphanIds.length,
    reconciled: reconciledIds.length,
    reclaimed,
  });
});
