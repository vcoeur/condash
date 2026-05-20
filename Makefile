.PHONY: help install dev build start package typecheck format format-check test test-headless test-visible test-unit clean kill

DEV_PORT     ?= 5600
PREVIEW_PORT ?= 5601

# Electron opens an on-screen window unless it runs against a virtual display.
# Prefer xvfb-run for the Playwright suite when it's installed (the Linux dev
# norm — mirrors CI) so the window never appears or steals focus; fall back to
# a visible run where xvfb-run is absent (macOS/Windows). `make test-visible`
# always shows the window; `make test-headless` always wraps and errors out if
# xvfb-run is missing.
XVFB_RUN  := $(shell command -v xvfb-run 2>/dev/null)
TEST_WRAP := $(if $(XVFB_RUN),xvfb-run -a,)

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
	@echo "  test          build then run the Playwright suite (headless when xvfb-run is present)"
	@echo "  test-headless build then run the suite under xvfb-run (no window; errors if xvfb-run absent)"
	@echo "  test-visible  build then run the suite with the window visible (watch the run)"
	@echo "  test-unit    run vitest unit suite"
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
	$(TEST_WRAP) npm run test

test-headless:
	npm run build
	xvfb-run -a npm run test

test-visible:
	npm run build
	npm run test

test-unit:
	npx vitest run

kill:
	@lsof -ti:$(DEV_PORT) | xargs -r kill -9 || true

clean:
	rm -rf dist dist-electron release
