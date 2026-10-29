# Free My TV on the LG TV (webOS Developer Mode).
#   make build                  FreeMyTV-webos.ipk from tv.properties and config.properties
#   make install [TV=<ip>]      build, then install and open it on the TV
#   make uninstall [TV=<ip>]    remove it from the TV
#   make release [TV=<ip>]      build, install, tag the commit tv-YYYY-MM-DD-N (settings' hash, version), and
#                               publish to the Worker's private Homebrew Channel repository (home only)
#   make config-hash            the hash of the settings a build would use (secrets left out)
#   make note MSG="..."         the note on the TV's home screen (through the Worker; no reinstall)
#   make note-clear             remove it
#   make revoke-phone           the phone's Shortcuts stop working (only the Mac's key is left)
#   make new-phone-key          a fresh key for a phone, and its two Shortcuts rebuilt in out/shortcuts
#   make type TEXT="..."        types into the text field open on the TV (ENTER=1 presses Enter after)
# Settings are in tv.properties (tracked); the keys stay in config.properties (gitignored).
# Roll back: git checkout tv-YYYY-MM-DD-N && make install (code and settings both come back; the keys are today's).

TV ?= 192.168.0.4
PYTHON ?= python3

.PHONY: build install uninstall release config-hash note note-clear revoke-phone new-phone-key type

build:
	BUILD_TAG='$(BUILD_TAG)' DEVMODE_UNTIL='$(DEVMODE_UNTIL)' $(PYTHON) scripts/tvconfig.py merge >/dev/null
	$(PYTHON) scripts/tv_photos.py
	FREEMYTV_VERSION='$(FREEMYTV_VERSION)' $(PYTHON) webos/build.py --config out/effective.properties

# Always rebuild: install.py reuses any FreeMyTV-webos.ipk it finds, which after a checkout is the wrong one.
# The build carries Developer Mode's end (scripts/devmode.py asks the TV and LG; left out when it can't tell).
install:
	@mkdir -p out; $(PYTHON) scripts/devmode.py $(TV) > out/devmode-until || true
	$(MAKE) build BUILD_TAG='$(BUILD_TAG)' FREEMYTV_VERSION='$(FREEMYTV_VERSION)' DEVMODE_UNTIL="$$(cat out/devmode-until 2>/dev/null)"
	$(PYTHON) webos/install.py $(TV)

uninstall:
	$(PYTHON) webos/install.py $(TV) --uninstall

config-hash:
	@$(PYTHON) scripts/tvconfig.py hash

note:
	@test -n "$(MSG)" || { echo 'Usage: make note MSG="Bins out tonight"'; exit 2; }
	@$(PYTHON) scripts/note.py "$(MSG)"

note-clear:
	@$(PYTHON) scripts/note.py --clear

revoke-phone:
	@$(PYTHON) scripts/phone_key.py revoke

new-phone-key:
	@$(PYTHON) scripts/phone_key.py new

type:
	@test -n "$(TEXT)" || { echo 'Usage: make type TEXT="..." [ENTER=1] (with a text field open on the TV)'; exit 2; }
	@$(PYTHON) scripts/tv_type.py $(TV) "$(TEXT)" $(if $(ENTER),--enter,)

# Refuses a dirty tree, so the tag is exactly what went on the TV. The tag's name is chosen first (About this TV shows
# it): one more than the day's highest, never a gap. It's made only after the install succeeded. The tagging stays off the $(MAKE) line: make runs that line even
# under -n, so a dry run would tag.
release:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo 'Uncommitted changes: commit or stash them first, so the tag matches what goes on the TV.'; exit 1; fi
	@mkdir -p out; day=$$(date +%Y-%m-%d); \
	n=$$(git tag -l "tv-$$day-*" | sed "s/^tv-$$day-//" | sort -n | tail -1); \
	echo "tv-$$day-$$(( $${n:-0} + 1 ))" > out/release-tag; \
	base=$$($(PYTHON) -c "import json; print('.'.join(json.load(open('webos/appinfo.json'))['version'].split('.')[:2]))"); \
	printf '%s.%s%02d\n' "$$base" "$$(date +%y%j)" "$$(( $${n:-0} + 1 ))" > out/release-version
	$(MAKE) install TV=$(TV) BUILD_TAG="$$(cat out/release-tag 2>/dev/null)" FREEMYTV_VERSION="$$(cat out/release-version 2>/dev/null)"
	@tag=$$(cat out/release-tag); hash=$$($(PYTHON) scripts/tvconfig.py hash) || exit 1; \
	git tag -a "$$tag" -m "Installed on $(TV)" -m "config-sha256: $$hash" -m "version: $$(cat out/release-version)" && rm out/release-tag && echo "Tagged $$tag (config $$hash)"
	@$(PYTHON) scripts/publish_repo.py "$$(cat out/release-version)" && rm -f out/release-version
