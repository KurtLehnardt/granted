import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSeenWelcomeGuide,
  markWelcomeGuideSeen,
  shouldAutoStartWelcomeGuide,
} from '../welcomeGuidePrefs';

/**
 * Welcome guide "auto-show at most once ever per browser" contract. The
 * storage calls degrade to their SSR/no-window fallback under node:test (no
 * `window` global, same posture as lib/sidebar/__tests__/sidebarPrefs.test.ts)
 * — those assertions cover the never-throw guarantee. shouldAutoStartWelcomeGuide
 * is the pure decision function the provider's mount effect calls, exercised
 * exhaustively here without mocking storage, DOM, or React.
 */
describe('welcomeGuidePrefs', () => {
  test('hasSeenWelcomeGuide never throws and defaults to false without window', () => {
    assert.equal(hasSeenWelcomeGuide(), false);
  });

  test('markWelcomeGuideSeen never throws without window (SSR no-op)', () => {
    assert.doesNotThrow(() => markWelcomeGuideSeen());
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
