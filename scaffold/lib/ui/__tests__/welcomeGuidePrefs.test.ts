import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSeenWelcomeGuide,
  markWelcomeGuideSeen,
  shouldAutoStartWelcomeGuide,
} from '../welcomeGuidePrefs';
import { STORAGE_KEYS } from '@/lib/mockAuth';

/**
 * Welcome guide "auto-show at most once ever per browser" contract.
 * shouldAutoStartWelcomeGuide is the pure decision function the provider's
 * mount effect calls, exercised exhaustively here without mocking storage,
 * DOM, or React. hasSeenWelcomeGuide's storage-backed cases use the same
 * in-memory `Storage` polyfill as lib/__tests__/mockAuth.test.ts.
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

describe('welcomeGuidePrefs', () => {
  test('hasSeenWelcomeGuide never throws and defaults to false without window', () => {
    delete (globalThis as any).window;
    assert.equal(hasSeenWelcomeGuide(), false);
  });

  test('markWelcomeGuideSeen never throws without window (SSR no-op)', () => {
    delete (globalThis as any).window;
    assert.doesNotThrow(() => markWelcomeGuideSeen());
  });

  describe('hasSeenWelcomeGuide — existing users are already "seen"', () => {
    let mem: MemStorage;
    beforeEach(() => {
      mem = new MemStorage();
      (globalThis as any).window = { localStorage: mem };
    });

    test('false for a genuinely new browser', () => {
      assert.equal(hasSeenWelcomeGuide(), false);
    });

    test('true once markWelcomeGuideSeen has been called', () => {
      markWelcomeGuideSeen();
      assert.equal(hasSeenWelcomeGuide(), true);
    });

    test('true when only the legacy WelcomeTour "seen" key is set', () => {
      mem.setItem('ff.ui.welcomeTour.seen.v1', 'true');
      assert.equal(hasSeenWelcomeGuide(), true);
    });

    test('true when the user already has a prior saved run', () => {
      mem.setItem(
        STORAGE_KEYS.runs,
        JSON.stringify([{ id: 'run_1', savedAt: new Date().toISOString(), map: {} }]),
      );
      assert.equal(hasSeenWelcomeGuide(), true);
    });
  });

  describe('shouldAutoStartWelcomeGuide', () => {
    test('auto-starts on a fresh mount when never seen', () => {
      assert.equal(shouldAutoStartWelcomeGuide({ started: false, seen: false }), true);
    });

    test('does not restart within the same mount once already started', () => {
      assert.equal(shouldAutoStartWelcomeGuide({ started: true, seen: false }), false);
    });

    test('never auto-starts again once this browser has already seen it', () => {
      assert.equal(shouldAutoStartWelcomeGuide({ started: false, seen: true }), false);
    });

    test('seen + started both block regardless of combination', () => {
      assert.equal(shouldAutoStartWelcomeGuide({ started: true, seen: true }), false);
    });
  });
});
