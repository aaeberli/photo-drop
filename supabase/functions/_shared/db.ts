/**
 * Service-role Supabase client. Bypasses RLS, so it must only ever be
 * constructed inside an edge function — never handed to a browser.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.47.10";
import { requireEnv } from "./env.ts";

/** Originals in transit to Google Photos. Emptied by the sync worker. */
export const UPLOAD_BUCKET = "uploads";

/** Permanent collage-sized copies. What the collage actually renders. */
export const DISPLAY_BUCKET = "display";

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return cached;
}
