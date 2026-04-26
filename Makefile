.PHONY: help install dev build start package typecheck format test clean kill

DEV_PORT     ?= 5600
PREVIEW_PORT ?= 5601

help:
	@echo "Targets:"
	@echo "  install     npm install"
	@echo "  dev         run main + renderer + electron in watch mode"
	@echo "  build       compile main and renderer for production"
	@echo "  start       launch the packaged electron build"
	@echo "  package     produce installers via electron-builder"
	@echo "  typecheck   run tsc on both main and renderer"
	@echo "  format      run prettier on src/"
	@echo "  kill        free dev port $(DEV_PORT)"
	@echo "  clean       remove build outputs"

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

test:
	npm run build
	npm run test

kill:
	@lsof -ti:$(DEV_PORT) | xargs -r kill -9 || true

clean:
	rm -rf dist dist-electron release
