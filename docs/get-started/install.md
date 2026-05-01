---
title: Install · condash
description: Download and launch the unsigned Electron build of condash on Linux, macOS, or Windows — including the one-time bypass gesture each OS asks for.
---

# Install

> **Audience.** New user — never used condash before, want it on your machine.

**When to read this.** You downloaded condash from the GitHub Releases page and your OS is asking whether to trust it.

The Electron builds of condash are **unsigned on purpose**. Signing Windows and macOS binaries costs $180–400/year in cert fees, and condash is a single-developer tool. Each OS asks you to confirm the download once on first launch; this page walks through the gesture per platform.

## Download

> **Debian/Ubuntu users**: skip the download and jump to [Linux — apt repository](#linux-apt-repository-recommended) below — `apt` will fetch the package and keep it up to date for you.

Start at the [latest release page](https://github.com/vcoeur/condash/releases/latest) and pick the artifact for your OS:

| OS | Artifact | Typical size |
|---|---|---|
| Linux | `condash-<version>.AppImage` | ~120 MB |
| Linux (Debian/Ubuntu) | `condash_<version>_amd64.deb` | ~90 MB |
| macOS | `condash-<version>.dmg` | ~110 MB |
| Windows | `condash Setup <version>.exe` | ~85 MB |

The Electron tag-push workflow publishes a **prerelease** directly — releases are visible immediately. If the page is empty, the maintainer hasn't pushed a tag yet. See **[Releases](releases.md)** for the full story.

## Linux — AppImage

```bash
chmod +x condash-*.AppImage
./condash-*.AppImage
```

That's it. Linux trusts you.

The AppImage's `AppRun` is patched at build time to launch Electron with `--no-sandbox`. AppImage extracts to `/tmp/.mount_*/`, which most distros mount `nosuid` — so Chromium's SUID sandbox helper loses its setuid bit and refuses to start. The patch lets the AppImage run anywhere without the user having to manage `chrome-sandbox` permissions. If you'd rather keep the sandbox, use the `.deb` (it installs `chrome-sandbox` at `/opt/condash/` where the SUID bit is honoured).

If the window doesn't appear, check stderr — a missing system library is the usual culprit. Install Electron's runtime deps with your distro's package manager:

```bash
sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1   # Debian/Ubuntu
sudo dnf install nss atk at-spi2-atk gtk3 mesa-libgbm             # Fedora
```

## Linux — apt repository (recommended)

A signed apt repository at `condash.vcoeur.com/apt/` lets `apt` track new versions for you — `apt upgrade` becomes the update mechanism.

One-time setup:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://condash.vcoeur.com/apt/pubkey.asc \
  | sudo gpg --dearmor -o /etc/apt/keyrings/condash.gpg
echo "deb [signed-by=/etc/apt/keyrings/condash.gpg] https://condash.vcoeur.com/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/condash.list

sudo apt update
sudo apt install condash
```

Updates from then on are just:

```bash
sudo apt update && sudo apt upgrade
```

The repository is signed with key fingerprint `BC6C 98E8 D6D8 0FFB C408 057F D1D6 9E3E 4A00 5621`.

## Linux — `.deb` (one-off)

If you don't want to add a repository, install a downloaded `.deb` directly:

```bash
sudo apt install ./condash_*_amd64.deb
condash
```

Apt pulls in Electron's runtime deps automatically. Updates require re-running this for every new release.

## macOS — Gatekeeper bypass

macOS tightens Gatekeeper with each release; the bypass gesture depends on your version.

### macOS 14 (Sonoma) and earlier

1. Double-click the `.dmg` and drag `condash.app` to `/Applications`.
2. In Finder, **control-click** `condash.app` → **Open**.
3. macOS shows "condash can't be opened because the developer cannot be verified. Are you sure you want to open it?" — click **Open**.

### macOS 15 (Sequoia) and later

Apple removed the control-click bypass in Sequoia.

1. Double-click `condash.app`. macOS refuses with "condash cannot be opened…".
2. Dismiss the dialog.
3. Open **System Settings → Privacy & Security**.
4. Scroll to the bottom — you'll see "condash was blocked from use because it is not from an identified developer" with an **Open Anyway** button.
5. Click **Open Anyway** and authenticate. Relaunch; condash opens normally.

### If the app still won't open

macOS sometimes flags the `.dmg` as "damaged". Clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/condash.app
```

Then click **Open Anyway** once. The decision is remembered.

## Windows — SmartScreen bypass

1. Double-click `condash Setup <version>.exe`. Windows dims the screen and shows "Windows protected your PC".
2. Click the small **More info** link under the banner.
3. Click the **Run anyway** button that appears.

The installer runs normally. You only do this on first launch — but a new release (different bytes) triggers the same dialog again, which is expected for unsigned binaries.

## After install

The first time you launch condash, it opens a folder picker and asks you to select your conception tree. See **[First launch](first-launch.md)** for what that is and how to set it up.

## Auto-update

condash ships with `electron-updater` wired against its GitHub Releases. On launch the app checks the latest published release, downloads the matching artifact in the background, and prompts to restart when it's ready. The channel files (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) are uploaded alongside the installers by the release workflow.

Caveats:

- **macOS unsigned bundles**: macOS re-flags freshly downloaded binaries as quarantined; the relaunch may fail silently. If condash refuses to come back up after an update prompt, drop the quarantine attribute (`xattr -dr com.apple.quarantine /Applications/condash.app`) and reopen.
- **Linux AppImage**: `electron-updater` rewrites the running AppImage in place. Make sure the AppImage lives somewhere writable by your user (not under `/opt/`).
- **Linux apt**: the apt repository updates outside `electron-updater`'s pipeline. **Debian/Ubuntu users who installed via the apt repository above are exempt from in-app updates** — `sudo apt update && sudo apt upgrade` picks up new condash versions automatically.
