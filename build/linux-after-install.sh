#!/bin/bash

# Custom electron-builder deb postinst.
#
# Differs from the stock template in one place: chrome-sandbox is always
# chmod 4755 (SUID), regardless of the unshare --user probe.
#
# Why: stock postinst runs `unshare --user true` and only sets SUID when that
# fails. On Ubuntu 23.10+ the kernel feature is enabled (so `unshare` succeeds)
# but AppArmor's apparmor_restrict_unprivileged_userns=1 blocks the
# user-namespace sandbox for unconfined binaries. Chromium then can't fall
# back to the SUID sandbox either (chrome-sandbox is mode 0755, not 4755) and
# aborts with "The SUID sandbox helper binary was found, but is not configured
# correctly". Forcing SUID makes the SUID-sandbox path work everywhere; the
# kernel still applies userns when permitted and the SUID binary is harmless
# otherwise.
#
# See knowledge/topics/ops/electron-appimage-no-sandbox.md in the conception
# repo for the full failure analysis.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
