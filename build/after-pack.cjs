// electron-builder afterPack hook — wraps the Linux Electron binary with a
// small bash launcher that exports ELECTRON_OZONE_PLATFORM_HINT=wayland on
// Wayland sessions BEFORE the binary starts.
//
// Why a wrapper at all: Electron's C++ early-init reads
// ELECTRON_OZONE_PLATFORM_HINT before the JS main process loads, so calling
// `app.commandLine.appendSwitch('ozone-platform-hint', 'wayland')` from
// src/main/index.ts is too late for the Ozone platform selection on the
// AppImage path. Without the env var, the packaged build falls back to
// XWayland and renders blurry on fractional-scaled monitors. See
// projects/2026-04/2026-04-29-condash-appimage-wayland-env/.
//
// The wrap covers both targets:
//   - AppImage: AppRun → ${productName} (this wrapper) → ${productName}.bin
//   - .deb:     /usr/bin/condash → /opt/condash/condash (this wrapper) → condash.bin
//
// macOS / Windows are untouched.

const fs = require('node:fs');
const path = require('node:path');

const WRAPPER_SCRIPT = `#!/usr/bin/env bash
# Two-mode launcher: CLI fast-path or GUI launch.
#
# CLI fast-path: when the first non-flag arg is a known noun (projects /
# knowledge / skills / search / repos / worktrees / dirty / config / help),
# we skip Chromium init entirely and run the bundled Electron binary in
# plain-Node mode via ELECTRON_RUN_AS_NODE=1. That path resolves the CLI
# bundle from app.asar.unpacked/ (electron-builder unpacks dist-cli/ +
# conception-template/ so plain Node fs can read them). Startup is ~50ms
# vs. ~250ms for full Electron init.
#
# GUI launch: original behaviour. Wayland Ozone hint exported before the
# Electron binary starts so the C++ early init picks the native Wayland
# backend instead of XWayland (which always blits at integer scale and
# produces blurry text on fractional monitors). No-op on X11 or non-Wayland.

DIR="$(dirname -- "$(readlink -f -- "$0")")"
BIN="$DIR/__BIN_NAME__"

# Detect a CLI noun in args. Skip flag tokens, then test the first positional
# against the known set. Anything not on this list (or no positional at all)
# falls through to GUI mode.
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;
    projects|knowledge|skills|search|repos|worktrees|dirty|config|help)
      CLI_BUNDLE="$DIR/resources/app.asar.unpacked/dist-cli/condash.cjs"
      if [ -f "$CLI_BUNDLE" ]; then
        export ELECTRON_RUN_AS_NODE=1
        exec "$BIN" "$CLI_BUNDLE" "$@"
      fi
      # Fall through: if the unpacked bundle is missing for some reason,
      # let the GUI binary start; main/index.ts has its own dispatch as a
      # belt-and-braces fallback.
      break
      ;;
    *) break ;;
  esac
done

if [ "\${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "\${ELECTRON_OZONE_PLATFORM_HINT:-}" ]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi
exec "$BIN" "$@"
`;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const realBinary = path.join(appOutDir, productFilename);
  const renamedBinary = path.join(appOutDir, `${productFilename}.bin`);

  if (!fs.existsSync(realBinary)) {
    throw new Error(`afterPack: expected binary at ${realBinary} but did not find it`);
  }
  if (fs.existsSync(renamedBinary)) {
    // Idempotent — re-running shouldn't re-wrap a wrapper.
    return;
  }

  fs.renameSync(realBinary, renamedBinary);
  const script = WRAPPER_SCRIPT.replace('__BIN_NAME__', `${productFilename}.bin`);
  fs.writeFileSync(realBinary, script, { mode: 0o755 });
};
