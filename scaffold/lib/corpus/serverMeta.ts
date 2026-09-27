import { getCorpusMeta } from "./store";
import { parseBuiltAt, type CorpusAsOf } from "./meta";

/**
 * Server-only: the active corpus's "as of" surface — the local refresh's
 * stamp when one exists, else the committed snapshot's (lib/corpus/store.ts).
 * `null` when the stamp is missing/invalid. Never import this from a "use
 * client" component (it pulls in `node:fs`) — client code fetches
 * GET /api/corpus instead (see components/OpportunityMap.tsx).
 */
export function corpusAsOf(): CorpusAsOf | null {
  return parseBuiltAt(getCorpusMeta());
}
