"""CLI smoke tests — cover the three subcommands every user runs on first install."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from condash import cli as cli_module
from condash.cli import app
from condash.config import CondashConfig, load

runner = CliRunner()


def test_version_flag():
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip().startswith("condash ")


def test_init_creates_config(tmp_home: Path):
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0, result.output
    cfg_path = tmp_home / ".config" / "condash" / "config.toml"
    assert cfg_path.is_file()
    assert "conception_path" in cfg_path.read_text(encoding="utf-8")


def test_config_path_prints_path(tmp_home: Path):
    runner.invoke(app, ["init"])
    result = runner.invoke(app, ["config", "path"])
    assert result.exit_code == 0, result.output
    assert "config.toml" in result.stdout


def test_config_path_json(tmp_home: Path):
    runner.invoke(app, ["init"])
    result = runner.invoke(app, ["config", "path", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["config_file"].endswith("config.toml")
    assert payload["exists"] is True


def test_config_show_json_is_valid(tmp_home: Path):
    runner.invoke(app, ["init"])
    result = runner.invoke(app, ["config", "show", "--json"])
    assert result.exit_code == 0, result.output
    parsed = json.loads(result.stdout)
    # A freshly-seeded config leaves every path field commented out — the
    # CLI still renders them as keys with null values.
    assert "conception_path" in parsed
    assert "port" in parsed
    assert "open_with" in parsed


def _write_config_with(tmp_path: Path, *, port: int, native: bool) -> Path:
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text(f"port = {port}\nnative = {str(native).lower()}\n", encoding="utf-8")
    return cfg_file


def test_load_port_override_replaces_config_value(tmp_path: Path):
    cfg_file = _write_config_with(tmp_path, port=8080, native=True)
    cfg = load(path=cfg_file, port_override=9000)
    assert cfg.port == 9000
    # Untouched fields fall back to the config file value.
    assert cfg.native is True


def test_load_native_override_can_force_off(tmp_path: Path):
    cfg_file = _write_config_with(tmp_path, port=8080, native=True)
    cfg = load(path=cfg_file, native_override=False)
    assert cfg.native is False
    assert cfg.port == 8080


def test_load_no_overrides_keeps_config_values(tmp_path: Path):
    cfg_file = _write_config_with(tmp_path, port=8080, native=False)
    cfg = load(path=cfg_file)
    assert cfg.port == 8080
    assert cfg.native is False


def test_load_rejects_out_of_range_port_override(tmp_path: Path):
    cfg_file = _write_config_with(tmp_path, port=0, native=True)
    with pytest.raises(Exception, match="--port"):
        load(path=cfg_file, port_override=99999)


def test_cli_overrides_reach_app_run(tmp_home: Path, monkeypatch: pytest.MonkeyPatch):
    """End-to-end: --port and --no-native reach the cfg passed to app.run()."""
    runner.invoke(app, ["init"])

    captured: dict[str, CondashConfig] = {}

    class _FakeAppModule:
        @staticmethod
        def run(cfg: CondashConfig) -> None:
            captured["cfg"] = cfg

    monkeypatch.setattr(cli_module, "app", app)  # keep the Typer app
    # cli_module imports `from . import app as app_module` lazily inside
    # `_root`; patch the module-level `condash.app` attribute so the import
    # picks up the fake.
    import condash

    monkeypatch.setattr(condash, "app", _FakeAppModule, raising=False)

    result = runner.invoke(app, ["--port", "9123", "--no-native"])
    assert result.exit_code == 0, result.output
    cfg = captured["cfg"]
    assert cfg.port == 9123
    assert cfg.native is False
