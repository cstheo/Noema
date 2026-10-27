.DEFAULT_GOAL := help
TOOLS_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
CARGO ?= cargo
CARGO_FLAGS ?= --locked
ARGS ?= --help
RUN = $(CARGO) run --quiet --release $(CARGO_FLAGS)

.PHONY: help build check fmt clean mobile obsidian deploy

help:
	@printf '%s\n' \
	  'Usage: make -C tools <target> [ARGS="..."]' \
	  '' \
	  '  build              Build both release binaries' \
	  '  check              Check formatting and run strict Clippy' \
	  '  fmt                Format Rust' \
	  '  clean              Remove Cargo build output' \
	  '  mobile / obsidian  Run either CLI with ARGS (default: --help)' \
	  '  deploy             Deploy Obsidian, then install mobile (close Obsidian first)'

build:
	cd "$(TOOLS_DIR)" && $(CARGO) build --release --workspace $(CARGO_FLAGS)

check:
	cd "$(TOOLS_DIR)" && $(CARGO) fmt --all -- --check
	cd "$(TOOLS_DIR)" && $(CARGO) clippy --workspace --all-targets $(CARGO_FLAGS) -- -D warnings

fmt:
	cd "$(TOOLS_DIR)" && $(CARGO) fmt --all

clean:
	cd "$(TOOLS_DIR)" && $(CARGO) clean

mobile obsidian:
	cd "$(TOOLS_DIR)" && $(RUN) -p Noema-$@ -- $(ARGS)

# Keep deployment ordered even when make is invoked with -j.
deploy:
	cd "$(TOOLS_DIR)" && $(RUN) -p Noema-obsidian -- deploy --apply
	cd "$(TOOLS_DIR)" && $(RUN) -p Noema-mobile -- install
