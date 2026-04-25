#!/usr/bin/env bash
# Fail if any HTML / Jinja / Rust template carries an inline non-click
# `on*=` handler that calls a named function. DOM-API expressions on
# `event.` (e.g. `onmousedown="event.stopPropagation()"`) are kept as
# inline because they don't reach into the bundle's symbol surface.
#
# Conversion contract: every named-handler `on*=` becomes a `data-*`
# attribute + `addEventListener` from a section module's
# `init*SideEffects()`. See conception 2026-04-25 architecture audit
# notes/04-extension.md T-2 and notes/05-simplicity.md S-D.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

paths=(
    "frontend/dashboard.html"
    "crates/condash-render/templates"
    "crates/condash-render/src"
)

# Pull every inline-handler value, then drop the `event.*` rows.
hits=$(grep -rEhno \
    'on(input|submit|change|pointerdown|mousedown|dblclick|keydown)="[^"]+"' \
    "${paths[@]}" 2>/dev/null \
    | grep -v -E '="\s*event\.' \
    || true)

if [ -n "$hits" ]; then
    echo "ERROR: inline non-click handlers detected (use data-* + addEventListener):"
    echo "$hits"
    exit 1
fi

echo "ok: no inline named-handler attributes"
