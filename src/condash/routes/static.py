"""Static + vendored-asset routes.

Serves the dashboard shell at ``/`` (HTML rendered by :mod:`render`),
favicons, the vendored frontend libraries (Mozilla PDF.js, xterm.js,
CodeMirror 6, Mermaid) under ``/vendor/<lib>/{rel_path}``, and the
esbuild-built dashboard bundle under ``/assets/dist/{rel_path}``. Each
route is a narrow read-only window into the package's ``assets/`` tree
with a regex-free traversal guard.
"""

from __future__ import annotations

from importlib.resources import files as _package_files
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, Response

from ..context import favicon_bytes
from ..render import render_page
from ..state import AppState

_PDFJS_MIME = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".icc": "application/octet-stream",
    ".css": "text/css",
}

_XTERM_MIME = {
    ".js": "text/javascript",
    ".css": "text/css",
}

_MERMAID_MIME = {
    ".js": "text/javascript",
}

_DIST_MIME = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".map": "application/json",
}


def _serve_under_assets(
    subpath: tuple[str, ...],
    rel_path: str,
    mime_table: dict[str, str] | None = None,
) -> Response:
    """Read-only window into ``assets/<subpath>/`` with a traversal guard."""
    if not rel_path or "\x00" in rel_path:
        return Response(status_code=403)
    parts = rel_path.split("/")
    if any(p in ("", "..") for p in parts):
        return Response(status_code=403)
    base = Path(str(_package_files("condash").joinpath("assets", *subpath)))
    try:
        full = (base / rel_path).resolve()
        full.relative_to(base.resolve())
    except (OSError, ValueError):
        return Response(status_code=403)
    if not full.is_file():
        return Response(status_code=404)
    if mime_table is None:
        ctype = "text/javascript" if full.suffix == ".js" else "text/plain"
    else:
        ctype = mime_table.get(full.suffix.lower(), "application/octet-stream")
    return Response(
        content=full.read_bytes(),
        media_type=ctype,
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _serve_vendor(lib: str, rel_path: str, mime_table: dict[str, str] | None = None) -> Response:
    """Read-only window into ``assets/vendor/<lib>/``."""
    return _serve_under_assets(("vendor", lib), rel_path, mime_table)


def build_router(state: AppState) -> APIRouter:
    router = APIRouter()

    @router.get("/", response_class=HTMLResponse)
    def index():
        ctx = state.get_ctx()
        assert state.cache is not None
        items = state.cache.get_items(ctx)
        return HTMLResponse(content=render_page(ctx, items, cache=state.cache))

    @router.get("/favicon.svg")
    def favicon_svg():
        data = favicon_bytes()
        if data is None:
            return Response(status_code=404)
        return Response(
            content=data,
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @router.get("/favicon.ico")
    def favicon_ico():
        data = favicon_bytes()
        if data is None:
            return Response(status_code=404)
        return Response(content=data, media_type="image/svg+xml")

    @router.get("/vendor/pdfjs/{rel_path:path}")
    def pdfjs_asset(rel_path: str):
        """Serve the vendored Mozilla PDF.js library to the in-modal viewer."""
        return _serve_vendor("pdfjs", rel_path, _PDFJS_MIME)

    @router.get("/vendor/xterm/{rel_path:path}")
    def xterm_asset(rel_path: str):
        """Serve the vendored xterm.js bundle (lib + CSS + fit addon)."""
        return _serve_vendor("xterm", rel_path, _XTERM_MIME)

    @router.get("/vendor/codemirror/{rel_path:path}")
    def codemirror_asset(rel_path: str):
        """Serve the vendored CodeMirror 6 IIFE bundle (config modal + note editor)."""
        return _serve_vendor("codemirror", rel_path)

    @router.get("/vendor/mermaid/{rel_path:path}")
    def mermaid_asset(rel_path: str):
        """Serve the vendored Mermaid UMD bundle to the note preview modal."""
        return _serve_vendor("mermaid", rel_path, _MERMAID_MIME)

    @router.get("/assets/dist/{rel_path:path}")
    def dist_asset(rel_path: str):
        """Serve the esbuild-built dashboard bundle (bundle.js / bundle.css)."""
        return _serve_under_assets(("dist",), rel_path, _DIST_MIME)

    return router
