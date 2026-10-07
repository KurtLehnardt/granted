/**
 * Seals the macOS app bundle with an ad-hoc code signature. electron-builder
 * runs this from its `afterPack` hook, which happens after the .app is
 * assembled and before the .dmg is built from it, so the .dmg ships the
 * sealed bundle.
 *
 * Why this is needed even though the release is deliberately unsigned and
 * un-notarized (no paid Apple Developer account):
 *
 *   `"identity": null` makes electron-builder skip signing altogether. The
 *   bundle is then left carrying only the ad-hoc, linker-signed signature
 *   that Electron's own prebuilt binary ships with — a signature that
 *   declares sealed resources while the repackaged bundle has none. Apple's
 *   own tools call that invalid, not merely untrusted:
 *
 *     codesign --verify --deep --strict "Granted Setup.app"
 *       -> code has no resources but signature indicates they must be present
 *     syspolicy_check distribution "Granted Setup.app"
 *       -> Codesign Error ... Severity: Fatal
 *
 *   Verified on this project's own build on macOS 27.0.1 (arm64): a copy of
 *   that bundle with a download's com.apple.quarantine attribute set is
 *   refused outright, with no "unidentified developer" prompt and so no
 *   "Open Anyway" to click; the same copy with quarantine cleared launches
 *   fine. An invalid signature is the wrong failure to hand a user — it has
 *   no documented way out. Sealing the bundle ad-hoc makes the signature
 *   valid and self-consistent, so a quarantined first launch gets the
 *   ordinary unsigned-app treatment the README documents instead.
 *
 * This is NOT a substitute for Developer ID signing and notarization: an
 * ad-hoc signature has no identity and Gatekeeper still blocks a first
 * launch. It only makes the block the expected, escapable one. The
 * signing/notarization slot in .github/workflows/release.yml is where real
 * signing replaces this.
 *
 * `--deep` is deprecated for Developer ID signing, where each nested binary
 * should be signed on its own terms. For ad-hoc sealing of an Electron
 * bundle — frameworks, helper apps and all, none of which need entitlements
 * or an identity — it is the right tool, and one `codesign` call is far less
 * to keep correct than hand-walking Electron's bundle layout.
 */
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  // Fail the build here rather than shipping a .dmg whose app macOS refuses:
  // this is the exact check that fails without the signing above.
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
