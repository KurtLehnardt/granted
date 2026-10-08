/**
 * Settings' per-state "refresh just this one" link (`--only-source=<id>` on
 * refresh-corpus.mjs): pure scoping decisions, split into their own module
 * so they're directly unit-testable -- refresh-corpus.mjs itself runs its
 * real refresh unconditionally on import (top-level `await main()`), so it
 * can't be imported from a test.
 */

/** Whether source `id` should be freshly fetched this run. `onlySource` null
 *  means a normal, unscoped refresh -- every (selected) source is fetched. */
export function shouldFetchState(onlySource, id) {
  return onlySource == null || onlySource === id;
}

/** Whether to re-fetch grants.gov/SAM.gov this run. A scoped per-state
 *  refresh skips them to stay fast -- EXCEPT when no prior federal fetch
 *  ever happened (`hasPriorFederalFetch` false): there'd be nothing on disk
 *  to fall back on, so skipping would starve the merge of 0 federal records
 *  instead of reusing stale ones, and refresh-corpus.mjs's own unhealthy-
 *  source guard would (correctly) read that as a real outage and abort. */
export function shouldFetchFederal(onlySource, hasPriorFederalFetch) {
  return onlySource == null || !hasPriorFederalFetch;
}
