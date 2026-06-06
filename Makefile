.PHONY: help install dev build start package typecheck format format-check test test-headless test-visible test-unit deadcode kill clean

DEV_PORT     ?= 5600
PREVIEW_PORT ?= 5601

# Tests are HEADLESS BY DEFAULT — a run must never pop an Electron window onto
# the developer's screen and steal focus. The guarantee lives in `npm run test`
# (scripts/run-playwright.mjs), which wraps the whole suite in a throwaway Xvfb
# display with the Wayland socket dropped and the X11 Ozone backend pinned, so
# Electron renders into the virtual display, never the live compositor — no
# matter how the suite is launched. A direct `npx playwright test` that skips
# that wrapper is aborted by the globalSetup guard (tests/fixtures/headless-
# guard.ts) before any window opens. Opt into a visible run with
# CONDASH_TEST_HEADED=1 (`make test-visible`). This is the durable fix for the
# recurring "a window popped up mid-run" problem — wrapping only the Makefile in
# xvfb left every direct/ad-hoc invocation exposed.

help:
	@echo "Targets:"
	@echo "  install      npm install"
	@echo "  dev          run main + renderer + electron in watch mode"
	@echo "  build        compile main and renderer for production"
	@echo "  start        launch the packaged electron build"
	@echo "  package      produce installers via electron-builder"
	@echo "  typecheck    run tsc on both main and renderer"
	@echo "  format       run prettier on src/"
	@echo "  format-check check prettier formatting without writing"
	@echo "  test          build then run the Playwright suite (headless by default — no window)"
	@echo "  test-headless build then run the suite (headless; xvfb wrap as defence in depth)"
	@echo "  test-visible  build then run the suite with the window visible (CONDASH_TEST_HEADED=1)"
	@echo "  test-unit    run vitest unit suite"
	@echo "  deadcode     run knip — fail on dead files / deps / duplicate exports"
	@echo "  kill         free dev port $(DEV_PORT)"
	@echo "  clean        remove build outputs"

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start:
	npm run start

package:
	npm run package

typecheck:
	npm run typecheck

format:
	npm run format

format-check:
	npx prettier --check "src/**/*.{ts,tsx,css,html,json}"

test:
	npm run build
	npm run test

test-headless:
	npm run build
	npm run test

test-visible:
	npm run build
	CONDASH_TEST_HEADED=1 npm run test

test-unit:
	npx vitest run

# Dead-code / over-export guard. knip.json grades issue types: dead files,
# dead/unlisted/unresolved deps, and duplicate exports are `error` (fail CI —
# this is the gate that keeps re-added back-compat aliases and orphaned files
# out); the pre-existing unused-export/type backlog is `warn` (reported, does
# not fail) pending a dedicated follow-up sweep. `electron-updater` is an
# intentionally-tracked-but-unimported dependency, allowlisted in knip.json.
deadcode:
	npx knip

kill:
	@lsof -ti:$(DEV_PORT) | xargs -r kill -9 || true

clean:
	rm -rf dist dist-electron release
