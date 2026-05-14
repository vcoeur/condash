// electron-builder afterPack hook — installs the `condash` launcher
// alongside a backward-compatible `condash-cli` alias on every platform.
//
// From v2.24.0 condash ships as a single user-facing binary. The dispatch
// rule (design: projects/2026-05/2026-05-13-condash-cli-reference/notes/
// 02-unified-binary-design.md, "rule C"):
//   • `condash`                         → GUI (no-args is the dashboard).
//   • `condash gui [chromium switches]` → GUI, with the rest of argv passed to Electron.
//   • `condash <anything else>`         → CLI (re-execs the same Electron binary
//                                          in plain-Node mode against dist-cli/condash.cjs).
//   • `condash-cli ...`                 → CLI (deprecated alias, removed in v3.0.0).
//                                          Prints a one-line stderr banner unless --quiet/-q.
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
//   /opt/condash/condash       ← dispatch bash wrapper (GUI vs CLI on argv1)
//   /opt/condash/condash-cli   ← copy of the same wrapper (deprecated alias)
//   /opt/condash/condash.bin   ← the real Electron binary
//   The bash postinst (build/linux-after-install.sh) drops a second
//   /usr/bin/condash-cli symlink alongside /usr/bin/condash.
//
// macOS (.app):
//   condash.app/Contents/MacOS/condash       ← Electron binary (untouched).
//                                              Dispatch happens in src/main/index.ts
//                                              when CLI args are present; the
//                                              dock / Finder paths go straight to GUI.
//   condash.app/Contents/MacOS/condash-cli   ← deprecated alias wrapper.
//
// Windows (NSIS):
//   <install>/condash.exe        ← Electron binary (untouched).
//                                  Dispatch happens in src/main/index.ts when
//                                  CLI args are present.
//   <install>/condash-cli.cmd    ← deprecated alias .cmd shim.
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
//
// Dispatch rule:
//   • Invoked as `condash-cli`        → CLI (deprecation banner unless --quiet/-q).
//   • Invoked as `condash` with no args → GUI.
//   • Invoked as `condash gui [args]` → GUI, with `gui` stripped.
//   • Invoked as `condash <anything>` → CLI.
const LINUX_WRAPPER = `#!/usr/bin/env bash
DIR="$(dirname -- "$(readlink -f -- "$0")")"
BIN="$DIR/__BIN_NAME__"
CLI_BUNDLE="$DIR/resources/app.asar.unpacked/dist-cli/condash.cjs"

INVOKED_NAME="$(basename -- "\${ARGV0:-$0}")"
INVOKED_NAME="\${INVOKED_NAME%.AppImage}"

run_cli() {
  if [ ! -f "$CLI_BUNDLE" ]; then
    echo "condash: CLI bundle not found at $CLI_BUNDLE" >&2
    exit 1
  fi
  export ELECTRON_RUN_AS_NODE=1
  exec "$BIN" "$CLI_BUNDLE" "$@"
}

run_gui() {
  if [ "\${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "\${ELECTRON_OZONE_PLATFORM_HINT:-}" ]; then
    export ELECTRON_OZONE_PLATFORM_HINT=wayland
  fi
  exec "$BIN" "$@"
}

if [ "$INVOKED_NAME" = "condash-cli" ]; then
  # Suppress the banner when --quiet / -q appears anywhere in argv. Match the
  # CLI's own --quiet semantics (src/cli/parser.ts:140) — anything else falls
  # through to the deprecation note.
  quiet=
  for arg in "$@"; do
    case "$arg" in
      --quiet|-q) quiet=1; break ;;
    esac
  done
  if [ -z "$quiet" ]; then
    echo "condash-cli: deprecated alias, use 'condash <command>' instead (alias removed in v3.0.0)." >&2
  fi
  run_cli "$@"
fi

# Invoked as condash. Dispatch on argv1.
if [ $# -eq 0 ]; then
  run_gui
fi

if [ "$1" = "gui" ]; then
  shift
  run_gui "$@"
fi

run_cli "$@"
`;

const MAC_CLI_WRAPPER = `#!/usr/bin/env bash
# condash-cli (macOS) — deprecated alias. Runs the bundled Electron binary
# in plain-Node mode against dist-cli/condash.cjs. The Electron binary lives
# at Contents/MacOS/condash; the unpacked CLI bundle lives at
# Contents/Resources/app.asar.unpacked/dist-cli/condash.cjs.
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
BIN="$DIR/condash"
CLI_BUNDLE="$DIR/../Resources/app.asar.unpacked/dist-cli/condash.cjs"
if [ ! -f "$CLI_BUNDLE" ]; then
  echo "condash-cli: CLI bundle not found at $CLI_BUNDLE" >&2
  exit 1
fi

quiet=
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) quiet=1; break ;;
  esac
done
if [ -z "$quiet" ]; then
  echo "condash-cli: deprecated alias, use 'condash <command>' instead (alias removed in v3.0.0)." >&2
fi

export ELECTRON_RUN_AS_NODE=1
exec "$BIN" "$CLI_BUNDLE" "$@"
`;

// Windows .cmd shim — deprecated alias. Banner printing in batch is fragile
// (argv iteration + redirection ordering), so emit it unconditionally; the
// banner is one line and Windows users get the same deprecation signal as
// every other platform. Quiet-aware suppression can be added once a user
// reports it as noise.
const WINDOWS_CLI_SHIM = `@echo off
setlocal
echo condash-cli: deprecated alias, use 'condash ^<command^>' instead (alias removed in v3.0.0). 1>&2
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
  // routes it to CLI mode + deprecation banner). Always overwrite — cheap
  // and idempotent.
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
