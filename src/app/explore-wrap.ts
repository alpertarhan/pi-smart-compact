/**
 * Thin re-export shim that lets `app/steps/synthesize.ts` reach the
 * exploration phase without importing through a deep path. Keeping the
 * indirection here means callers don't need to know whether the
 * implementation lives under `phases/` or some future `app/explore`.
 */

export { exploreConversation, shouldExplore } from "../phases/explore.ts";
