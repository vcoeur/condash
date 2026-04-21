"""Configuration read + write routes (form + raw-YAML paths).

The dashboard's gear modal POSTs ``/config`` with a structured payload;
the split-pane YAML view POSTs ``/config/yaml`` with a raw body.
Both end up running ``config_mod.save`` against an updated
:class:`CondashConfig` and rebuilding the live ``RenderCtx`` so paths,
repos, and ``open_with`` slots take effect on the next request.

Self-write stamping (:meth:`AppState.stamp_config_self_write`) suppresses
the watchdog's echo of this process's own save back through the reload
callback.

Schema-mapping (``config_to_payload`` / ``payload_to_config``) and the
shared repo-list parser live in :mod:`condash.config` so the validation
rules apply identically to TOML, YAML, and HTTP-payload inputs.
"""

from __future__ import annotations

import copy

import yaml
from fastapi import APIRouter, Request

from .. import config as config_mod
from ..context import build_ctx
from ..state import AppState
from ._common import error


def build_router(state: AppState) -> APIRouter:
    router = APIRouter()

    @router.get("/config")
    def get_config():
        cfg = state.cfg
        if cfg is None:
            return error(500, "config not initialised")
        return config_mod.config_to_payload(cfg)

    @router.post("/config")
    async def post_config(req: Request):
        if state.cfg is None:
            return error(500, "config not initialised")
        data = await req.json()
        try:
            new_cfg = config_mod.payload_to_config(data)
        except (ValueError, KeyError, TypeError) as exc:
            return error(400, f"invalid config: {exc}")
        # Stamp self-writes so the filesystem watcher doesn't echo our
        # own save back as an external reload event.
        state.stamp_config_self_write("repositories.yml", "preferences.yml")
        config_mod.save(new_cfg)
        # Rebuild the RenderCtx so paths / repos / open-with changes take
        # effect on the next request without needing a process restart.
        state.ctx = build_ctx(new_cfg)
        # Surface which fields require a restart to actually take effect.
        restart_required = []
        old = state.cfg
        if old.port != new_cfg.port:
            restart_required.append("port")
        if old.native != new_cfg.native:
            restart_required.append("native")
        state.cfg = new_cfg
        return {
            "ok": True,
            "restart_required": restart_required,
            "config": config_mod.config_to_payload(new_cfg),
        }

    @router.post("/config/yaml")
    async def post_config_yaml(req: Request):
        """Save a single YAML file verbatim (split-pane modal write path).

        Payload ``{"file": "repositories" | "preferences", "body": <yaml>}``.
        Parses the YAML, overlays it onto the live config, then runs through
        the same :func:`config_mod.save` + ``build_ctx`` path as the
        form-based ``POST /config`` so the on-disk state and runtime state
        stay in lockstep.
        """
        if state.cfg is None:
            return error(500, "config not initialised")
        try:
            data = await req.json()
        except ValueError:
            return error(400, "bad JSON")
        if not isinstance(data, dict):
            return error(400, "payload must be an object")
        which = str(data.get("file") or "").strip()
        body = data.get("body")
        if which not in ("repositories", "preferences"):
            return error(400, "file must be 'repositories' or 'preferences'")
        if not isinstance(body, str):
            return error(400, "body must be a string")
        if state.cfg.conception_path is None:
            return error(400, "conception_path is unset — set it in General first")
        try:
            parsed = yaml.safe_load(body)
        except yaml.YAMLError as exc:
            return error(400, f"malformed YAML: {exc}")
        if parsed is None:
            parsed = {}
        if not isinstance(parsed, dict):
            return error(400, "top-level YAML must be a mapping")
        # Clone the current config so a bad payload can't leave it
        # half-applied if _apply_* raises deep into the parse.
        draft = copy.deepcopy(state.cfg)
        try:
            if which == "repositories":
                target = config_mod.repositories_yaml_path(draft.conception_path)
                config_mod._apply_repositories_yaml(draft, parsed, target)  # noqa: SLF001
            else:
                target = config_mod.preferences_yaml_path(draft.conception_path)
                config_mod._apply_preferences_yaml(draft, parsed, target)  # noqa: SLF001
        except config_mod.ConfigIncompleteError as exc:
            return error(400, str(exc))
        # Stamp self-writes so the file watcher doesn't echo back.
        state.stamp_config_self_write("repositories.yml", "preferences.yml")
        config_mod.save(draft)
        state.ctx = build_ctx(draft)
        state.cfg = draft
        return {"ok": True, "config": config_mod.config_to_payload(draft)}

    return router
