/**
 * grantsStore.ts — FE-07 "Grants applied for" local tracker.
 *
 * A purely local, localStorage-backed list of grants the user is tracking,
 * each with a status they can set (unapplied / pending / granted). Gates
 * nothing, submits nothing — it's a personal checklist on this device only,
 * cleared by "Delete my data" along with everything else (STORAGE_KEYS.grants).
 *
 * Framework-agnostic (no React) so the sidebar can call it directly and it
 * stays trivially testable. Reads degrade to [] when storage is unavailable.
 */

import { STORAGE_KEYS } from '@/lib/mockAuth';
import { readJSON, writeJSON } from '@/lib/localStore';

export type GrantStatus = 'unapplied' | 'pending' | 'granted';

export interface Grant {
  id: string;
  title: string;
  status: GrantStatus;
  /** ISO timestamp the entry was added. */
  createdAt: string;
}

const VALID_STATUSES: readonly GrantStatus[] = ['unapplied', 'pending', 'granted'];

function newId(): string {
  return `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce a parsed value into a well-formed Grant[], dropping anything malformed. */
function normalize(value: unknown): Grant[] {
  if (!Array.isArray(value)) return [];
  const out: Grant[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, unknown>;
    if (typeof g.id !== 'string' || typeof g.title !== 'string') continue;
    const status = VALID_STATUSES.includes(g.status as GrantStatus)
      ? (g.status as GrantStatus)
      : 'unapplied';
    out.push({
      id: g.id,
      title: g.title,
      status,
      createdAt: typeof g.createdAt === 'string' ? g.createdAt : new Date(0).toISOString(),
    });
  }
  return out;
}

/** All tracked grants, newest first is not guaranteed — insertion order is kept. */
export function getGrants(): Grant[] {
  return normalize(readJSON<unknown>(STORAGE_KEYS.grants, []));
}

/**
 * Append a grant by title (trimmed). Ignores empty titles and returns the full
 * updated list so callers can refresh state in one step.
 */
export function addGrant(title: string): Grant[] {
  const trimmed = title.trim();
  if (trimmed.length === 0) return getGrants();
  const grants = getGrants();
  grants.push({ id: newId(), title: trimmed, status: 'unapplied', createdAt: new Date().toISOString() });
  writeJSON(STORAGE_KEYS.grants, grants);
  return grants;
}

/** Set a grant's status by id. No-op for an unknown id. Returns the updated list. */
export function setGrantStatus(id: string, status: GrantStatus): Grant[] {
  const grants = getGrants().map((g) => (g.id === id ? { ...g, status } : g));
  writeJSON(STORAGE_KEYS.grants, grants);
  return grants;
}

/** Remove a grant by id. Returns the updated list. */
export function removeGrant(id: string): Grant[] {
  const grants = getGrants().filter((g) => g.id !== id);
  writeJSON(STORAGE_KEYS.grants, grants);
  return grants;
}
