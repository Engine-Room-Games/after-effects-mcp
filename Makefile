.DEFAULT_GOAL := help
SHELL := /bin/bash

# `make release 1.1.0` passes the version as a second goal, which make would
# otherwise try to build. Capture it, and declare it as a do-nothing target —
# but only while releasing, so a plain typo like `make buld` still errors.
ifneq (,$(filter release,$(MAKECMDGOALS)))
RELEASE_VERSION := $(strip $(filter-out release,$(MAKECMDGOALS)))
ifneq (,$(RELEASE_VERSION))
$(RELEASE_VERSION):
	@:
endif
endif

.PHONY: help build jsx watch doctor verify panel clean release artifacts

help: ## Show this help
	@echo "Targets:"
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Release:"
	@echo -e "  \033[1mmake release\033[0m         bump the patch version and publish"
	@echo -e "  \033[1mmake release 1.1.0\033[0m   set an explicit version and publish"

build: ## Compile TypeScript and the ExtendScript bundle
	@npm run build

jsx: ## Rebuild bundle.jsx only, then hot-reload it into a running AE
	@npm run build:jsx
	@curl -fsS -X POST http://127.0.0.1:7777/reload-jsx >/dev/null 2>&1 \
		&& echo "reloaded into the running panel" \
		|| echo "panel not reachable — restart After Effects to pick this up"

watch: ## TypeScript watch mode
	@npm run watch:ts

doctor: ## Diagnose the After Effects connection
	@npm run doctor

panel: ## Install the CEP panel into After Effects
	@npm run install:panel

verify: ## Build, check versions agree, and dry-run the package
	@npm run build
	@node scripts/sync-version.mjs --check
	@node scripts/build-guides.mjs --check
	@npm publish --workspace @engine-room/after-effects-mcp --dry-run 2>&1 \
		| grep -E "name:|version:|total files|package size" || true

artifacts: ## Build the .mcpb and standalone binaries without releasing
	@npm run build
	@node scripts/build-mcpb.mjs
	@node scripts/build-binaries.mjs
	@echo ""
	@echo "Unsigned. To sign them:  ./scripts/sign-and-notarize.sh"

clean: ## Remove build output
	@rm -rf packages/*/dist packages/mcp-server/bin packages/mcp-server/panel dist-release
	@rm -f packages/ae-panel/jsx/bundle.jsx
	@echo "cleaned"

release: ## Bump the version, build and sign every artifact, tag, and publish
	@./scripts/release.sh $(RELEASE_VERSION)
