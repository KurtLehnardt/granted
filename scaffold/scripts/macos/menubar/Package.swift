// swift-tools-version:5.9
//
// Granted's macOS menu-bar helper: the counterpart of the Windows tray's
// NotifyIcon (scaffold/scripts/windows/granted-tray.ps1). A small native
// AppKit executable rather than an Electron tray, so running Granted in the
// background costs about what it costs on Windows -- where the tray is a
// scripted native icon, not a second long-lived runtime.
//
// Built with the Swift toolchain that ships with the Xcode Command Line
// Tools; there is no Xcode project and none is needed:
//
//   swift build -c release --package-path scaffold/scripts/macos/menubar
//
// scaffold/scripts/macos/granted-tray.sh runs exactly that the first time
// Granted starts in the background, and CI builds it the same way.
import PackageDescription

let package = Package(
  name: "granted-menubar",
  platforms: [.macOS(.v12)],
  products: [
    .executable(name: "granted-menubar", targets: ["GrantedMenuBar"])
  ],
  targets: [
    .executableTarget(name: "GrantedMenuBar", path: "Sources/GrantedMenuBar")
  ]
)
