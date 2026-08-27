import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEYS,
  signIn,
  signOut,
  getUser,
  isAuthenticated,
  isDemoMode,
  getDemoUser,
  enterDemoMode,
  exitDemoMode,
  getConsent,
  setConsent,
  getAutoFillRequirements,
  EMPTY_AUTO_FILL_REQUIREMENTS,
  mapAutoFillToCompanyProfileFields,
  clearAllLocalData,
} from "../mockAuth";

/**
 * mockAuth.ts — demo-only, localStorage-backed auth state machine (R9.0). No
 * React runtime here, so a minimal in-memory `Storage` polyfill is installed
 * on `globalThis.window` before each test (mockAuth.ts's own `safeStorage()`
 * only ever checks `typeof window === 'undefined'` / calls
 * `window.localStorage`, so this is enough — no jsdom needed).
 */

class MemStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

let mem: MemStorage;

beforeEach(() => {
  mem = new MemStorage();
  (globalThis as any).window = { localStorage: mem };
});

// ---------------------------------------------------------------------------
// Sign-in / sign-out
// ---------------------------------------------------------------------------

describe("signIn / signOut / getUser / isAuthenticated", () => {
  test("signIn() sets authed+user; getUser() returns the MockUser; isAuthenticated() true", () => {
    const user = signIn("Ada Lovelace");
    assert.equal(mem.getItem(STORAGE_KEYS.authed), "true");
    assert.ok(mem.getItem(STORAGE_KEYS.user));
    assert.deepEqual(getUser(), user);
    assert.equal(isAuthenticated(), true);
  });

  test("signOut() clears authed+user but leaves STORAGE_KEYS.runs and STORAGE_KEYS.consent untouched", () => {
    signIn();
    mem.setItem(STORAGE_KEYS.runs, JSON.stringify(["run-1"]));
    setConsent(true);
    const consentBefore = mem.getItem(STORAGE_KEYS.consent);
    const runsBefore = mem.getItem(STORAGE_KEYS.runs);

    signOut();

    assert.equal(mem.getItem(STORAGE_KEYS.authed), null);
    assert.equal(mem.getItem(STORAGE_KEYS.user), null);
    assert.equal(isAuthenticated(), false);
    assert.equal(mem.getItem(STORAGE_KEYS.runs), runsBefore);
    assert.equal(mem.getItem(STORAGE_KEYS.consent), consentBefore);
  });

  test("getUser() with a malformed stored user (missing id/name) -> null AND signs out as a side effect", () => {
    mem.setItem(STORAGE_KEYS.authed, "true");
    mem.setItem(STORAGE_KEYS.user, JSON.stringify({ email: "nobody@example.com" })); // no id/name
    assert.equal(getUser(), null);
    assert.equal(mem.getItem(STORAGE_KEYS.authed), null, "signOut side effect: authed key cleared");
    assert.equal(mem.getItem(STORAGE_KEYS.user), null, "signOut side effect: user key cleared");
  });

  test("getUser() with invalid JSON stored user -> null AND signs out as a side effect", () => {
    mem.setItem(STORAGE_KEYS.authed, "true");
    mem.setItem(STORAGE_KEYS.user, "{ not valid json");
    assert.equal(getUser(), null);
    assert.equal(mem.getItem(STORAGE_KEYS.authed), null, "signOut side effect: authed key cleared");
  });
});

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

describe("demo mode", () => {
  test("enterDemoMode() -> isDemoMode() true; getDemoUser() is idempotent (same user across repeated calls)", () => {
    const entered = enterDemoMode();
    assert.equal(isDemoMode(), true);
    const first = getDemoUser();
    const second = getDemoUser();
    assert.deepEqual(first, entered);
    assert.deepEqual(second, first);
  });

  test("exitDemoMode() clears demoMode/demoUser; getDemoUser() -> null", () => {
    enterDemoMode();
    exitDemoMode();
    assert.equal(isDemoMode(), false);
    assert.equal(getDemoUser(), null);
  });
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe("consent", () => {
  test("getConsent() defaults to {granted:false, grantedAt:null}", () => {
    assert.deepEqual(getConsent(), { granted: false, grantedAt: null });
  });

  test("setConsent(true) round-trips a non-null grantedAt", () => {
    const rec = setConsent(true);
    assert.equal(rec.granted, true);
    assert.ok(rec.grantedAt);
    assert.deepEqual(getConsent(), rec);
  });

  test("setConsent(false) -> grantedAt null", () => {
    setConsent(true);
    const rec = setConsent(false);
    assert.equal(rec.granted, false);
    assert.equal(rec.grantedAt, null);
    assert.deepEqual(getConsent(), rec);
  });
});

// ---------------------------------------------------------------------------
// Auto-fill requirements
// ---------------------------------------------------------------------------

describe("getAutoFillRequirements", () => {
  test("merges a partial stored record over EMPTY_AUTO_FILL_REQUIREMENTS (no undefined fields)", () => {
    mem.setItem(STORAGE_KEYS.autoFill, JSON.stringify({ samRegistered: true, uei: "X1" }));
    const reqs = getAutoFillRequirements();
    assert.equal(reqs.samRegistered, true);
    assert.equal(reqs.uei, "X1");
    // Every field absent from the partial stored record falls back to its
    // EMPTY_AUTO_FILL_REQUIREMENTS default, never undefined.
    assert.equal(reqs.samRegisteredDate, EMPTY_AUTO_FILL_REQUIREMENTS.samRegisteredDate);
    assert.equal(reqs.aorName, EMPTY_AUTO_FILL_REQUIREMENTS.aorName);
    assert.equal(reqs.aorOnFile, EMPTY_AUTO_FILL_REQUIREMENTS.aorOnFile);
    assert.equal(reqs.eBizPocOnFile, EMPTY_AUTO_FILL_REQUIREMENTS.eBizPocOnFile);
    for (const [key, value] of Object.entries(reqs)) {
      assert.notEqual(value, undefined, `field ${key} must not be undefined`);
    }
  });
});

// ---------------------------------------------------------------------------
// mapAutoFillToCompanyProfileFields
// ---------------------------------------------------------------------------

describe("mapAutoFillToCompanyProfileFields", () => {
  test("samRegistered:false, uei:'' -> {}", () => {
    const out = mapAutoFillToCompanyProfileFields({
      ...EMPTY_AUTO_FILL_REQUIREMENTS,
      samRegistered: false,
      uei: "",
    });
    assert.deepEqual(out, {});
  });

  test("samRegistered:true -> sam_registered {value:true, provenance:'user_stated', confidence:1}", () => {
    const out = mapAutoFillToCompanyProfileFields({
      ...EMPTY_AUTO_FILL_REQUIREMENTS,
      samRegistered: true,
    });
    assert.deepEqual(out.sam_registered, { value: true, provenance: "user_stated", confidence: 1 });
    assert.equal(out.uei, undefined);
  });

  test("uei '  X1  ' -> trimmed value, same provenance shape", () => {
    const out = mapAutoFillToCompanyProfileFields({
      ...EMPTY_AUTO_FILL_REQUIREMENTS,
      uei: "  X1  ",
    });
    assert.deepEqual(out.uei, { value: "X1", provenance: "user_stated", confidence: 1 });
  });
});

// ---------------------------------------------------------------------------
// clearAllLocalData — exhaustive over every key in STORAGE_KEYS
// ---------------------------------------------------------------------------

describe("clearAllLocalData", () => {
  test("wipes EVERY key in STORAGE_KEYS", () => {
    for (const key of Object.values(STORAGE_KEYS)) {
      mem.setItem(key, "sentinel");
    }
    clearAllLocalData();
    for (const key of Object.values(STORAGE_KEYS)) {
      assert.equal(mem.getItem(key), null, `expected STORAGE_KEYS entry "${key}" to be cleared`);
    }
  });
});
