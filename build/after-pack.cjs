// electron-builder afterPack hook — installs the `condash-cli` launcher
// alongside the GUI launcher, on every platform target. From v2.14.0 the
// `condash` binary is GUI-only; CLI invocations go through `condash-cli`,
// which runs the same packaged Electron binary in plain-Node mode
// (ELECTRON_RUN_AS_NODE=1) against the bundled `dist-cli/condash.cjs`.
//
// On Linux we additionally wrap the Electron binary itself with a bash
// launcher that exports ELECTRON_OZONE_PLATFORM_HINT=wayland on Wayland
// sessions before the C++ early-init reads it (otherwise the AppImage
// falls back to XWayland and renders blurry on fractional-scaled
// monitors — see projects/2026-04/2026-04-29-condash-appimage-wayland-env/).
//
// Layout produced per platform:
//
// Linux (.deb / AppImage):
//   /opt/condash/condash       ← argv0-dispatched bash wrapper
//   /opt/condash/condash-cli   ← copy of the same wrapper (different basename)
//   /opt/condash/condash.bin   ← the real Electron binary
//   The bash postinst (build/linux-after-install.sh) drops a second
//   /usr/bin/condash-cli symlink alongside /usr/bin/condash.
//
// macOS (.app):
//   condash.app/Contents/MacOS/condash       ← Electron binary (untouched)
//   condash.app/Contents/MacOS/condash-cli   ← bash CLI wrapper
//   No symlink in /usr/local/bin — users do `ln -s` themselves; documented
//   in the install guide.
//
// Windows (NSIS):
//   <install>/condash.exe        ← Electron binary (untouched)
//   <install>/condash-cli.cmd    ← .cmd shim
//   The install dir is appended to per-user PATH (HKCU\Environment\PATH)
//   by build/installer.nsh on install, removed on uninstall.

const fs = require('node:fs');
const path = require('node:path');

// argv0-dispatched bash wrapper. Two physical copies share this body —
// `/opt/condash/condash` (reachable as `/usr/bin/condash`) and
// `/opt/condash/condash-cli` (reachable as `/usr/bin/condash-cli`). Same
// body so the Wayland hint + Electron path resolution stay in one place;
// behaviour switches on `basename "$0"` (or `$ARGV0` when the wrapper is
// reached through an AppImage symlink — AppImage exports ARGV0 to the
// basename the user invoked).
const LINUX_WRAPPER = `#!/usr/bin/env bash
DIR="$(dirname -- "$(readlink -f -- "$0")")"
BIN="$DIR/__BIN_NAME__"

INVOKED_NAME="$(basename -- "\${ARGV0:-$0}")"
INVOKED_NAME="\${INVOKED_NAME%.AppImage}"

if [ "$INVOKED_NAME" = "condash-cli" ]; then
  CLI_BUNDLE="$DIR/resources/app.asar.unpacked/dist-cli/condash.cjs"
  if [ ! -f "$CLI_BUNDLE" ]; then
    echo "condash-cli: CLI bundle not found at $CLI_BUNDLE" >&2
    exit 1
  fi
  export ELECTRON_RUN_AS_NODE=1
  exec "$BIN" "$CLI_BUNDLE" "$@"
fi

if [ "\${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "\${ELECTRON_OZONE_PLATFORM_HINT:-}" ]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi
exec "$BIN" "$@"
`;

const MAC_CLI_WRAPPER = `#!/usr/bin/env bash
# condash-cli (macOS). Runs the bundled Electron binary in plain-Node mode
# against dist-cli/condash.cjs. The Electron binary lives at
# Contents/MacOS/condash; the unpacked CLI bundle lives at
# Contents/Resources/app.asar.unpacked/dist-cli/condash.cjs.
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
BIN="$DIR/condash"
CLI_BUNDLE="$DIR/../Resources/app.asar.unpacked/dist-cli/condash.cjs"
if [ ! -f "$CLI_BUNDLE" ]; then
  echo "condash-cli: CLI bundle not found at $CLI_BUNDLE" >&2
  exit 1
fi
export ELECTRON_RUN_AS_NODE=1
exec "$BIN" "$CLI_BUNDLE" "$@"
`;

const WINDOWS_CLI_SHIM = `@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0condash.exe" "%~dp0resources\\app.asar.unpacked\\dist-cli\\condash.cjs" %*
`;

async function wrapLinux(context) {
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const realBinary = path.join(appOutDir, productFilename);
  const renamedBinary = path.join(appOutDir, `${productFilename}.bin`);
  const cliLauncher = path.join(appOutDir, 'condash-cli');

  if (!fs.existsSync(realBinary)) {
    throw new Error(`afterPack: expected binary at ${realBinary} but did not find it`);
  }

  // Idempotent — re-running shouldn't re-wrap a wrapper.
  if (!fs.existsSync(renamedBinary)) {
    fs.renameSync(realBinary, renamedBinary);
    const script = LINUX_WRAPPER.replace('__BIN_NAME__', `${productFilename}.bin`);
    fs.writeFileSync(realBinary, script, { mode: 0o755 });
  }

  // condash-cli companion (same body, different basename so argv0 dispatch
  // routes it to CLI mode). Always overwrite — cheap and idempotent.
  const script = LINUX_WRAPPER.replace('__BIN_NAME__', `${productFilename}.bin`);
  fs.writeFileSync(cliLauncher, script, { mode: 0o755 });
}

async function wrapMac(context) {
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  // appOutDir is `<release>/mac/` (or `mac-arm64/`); the .app bundle lives
  // at `<appOutDir>/<productFilename>.app`.
  const appBundle = path.join(appOutDir, `${productFilename}.app`);
  const macOsDir = path.join(appBundle, 'Contents', 'MacOS');
  if (!fs.existsSync(macOsDir)) {
    throw new Error(`afterPack: expected MacOS dir at ${macOsDir} but did not find it`);
  }
  const cliLauncher = path.join(macOsDir, 'condash-cli');
  fs.writeFileSync(cliLauncher, MAC_CLI_WRAPPER, { mode: 0o755 });
}

async function wrapWindows(context) {
  const appOutDir = context.appOutDir;
  const cliShim = path.join(appOutDir, 'condash-cli.cmd');
  fs.writeFileSync(cliShim, WINDOWS_CLI_SHIM);
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform === 'linux') return wrapLinux(context);
  if (platform === 'darwin') return wrapMac(context);
  if (platform === 'win32') return wrapWindows(context);
};
