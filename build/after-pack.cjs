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
# Wayland Ozone hint — exported before the Electron binary so the C++ early
# init picks the native Wayland backend instead of XWayland (which always
# blits at integer scale and produces blurry text on fractional monitors).
# No-op when the user is on X11 or any non-Wayland session.
if [ "\${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "\${ELECTRON_OZONE_PLATFORM_HINT:-}" ]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi
exec "$(dirname -- "$(readlink -f -- "$0")")/__BIN_NAME__" "$@"
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
