// electron-builder afterPack hook — installs the `condash` launcher on Linux.
// macOS and Windows are no-ops; their dispatch (CLI vs GUI on argv) happens
// in src/main/index.ts since the Electron binary is invoked directly.
//
// From v3.0.0 condash ships as a single user-facing binary. Dispatch rule:
//   • `condash`                         → GUI (no-args is the dashboard).
//   • `condash gui [chromium switches]` → GUI, with the rest of argv passed to Electron.
//   • `condash <anything else>`         → CLI (re-execs the same Electron binary
//                                          in plain-Node mode against dist-cli/condash.cjs).
//
// The v2.x `condash-cli` deprecated alias was removed in v3.0.0.
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
//   /opt/condash/condash.bin   ← the real Electron binary
//
// macOS (.app):
//   condash.app/Contents/MacOS/condash       ← Electron binary (untouched).
//                                              Dispatch happens in src/main/index.ts
//                                              when CLI args are present; the
//                                              dock / Finder paths go straight to GUI.
//
// Windows (NSIS):
//   <install>/condash.exe        ← Electron binary (untouched).
//                                  Dispatch happens in src/main/index.ts when
//                                  CLI args are present.

const fs = require('node:fs');
const path = require('node:path');

// Bash wrapper for /opt/condash/condash. Dispatches on argv:
//   • no args            → GUI.
//   • `condash gui …`    → GUI, with `gui` stripped.
//   • `condash <other>`  → CLI (re-execs the Electron binary as Node against
//                                the bundled dist-cli/condash.cjs).
const LINUX_WRAPPER = `#!/usr/bin/env bash
DIR="$(dirname -- "$(readlink -f -- "$0")")"
BIN="$DIR/__BIN_NAME__"
CLI_BUNDLE="$DIR/resources/app.asar.unpacked/dist-cli/condash.cjs"

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

if [ $# -eq 0 ]; then
  run_gui
fi

if [ "$1" = "gui" ]; then
  shift
  run_gui "$@"
fi

run_cli "$@"
`;

async function wrapLinux(context) {
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const realBinary = path.join(appOutDir, productFilename);
  const renamedBinary = path.join(appOutDir, `${productFilename}.bin`);

  if (!fs.existsSync(realBinary)) {
    throw new Error(`afterPack: expected binary at ${realBinary} but did not find it`);
  }

  // Idempotent — re-running shouldn't re-wrap a wrapper.
  if (!fs.existsSync(renamedBinary)) {
    fs.renameSync(realBinary, renamedBinary);
    const script = LINUX_WRAPPER.replace('__BIN_NAME__', `${productFilename}.bin`);
    fs.writeFileSync(realBinary, script, { mode: 0o755 });
  }
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform === 'linux') return wrapLinux(context);
};
