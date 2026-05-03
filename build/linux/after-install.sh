#!/bin/sh
# Termpolis .deb postinst — runs after dpkg unpacks the package.
#
# Wired in via package.json -> build.deb.afterInstall. electron-builder
# copies this to DEBIAN/postinst and chmods 0755.

set -e

# 1. Resolve any transitive deps dpkg couldn't fetch (libgtk, libnss3, ...).
#    Without this, `sudo dpkg -i termpolis_*.deb` leaves the package in an
#    "unmet deps" state and users have to run `sudo apt-get install -f`
#    by hand. Skip silently on systems without apt.
if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -f -y || true
fi

# 2. Refresh desktop / icon caches so the launcher and dock pick up the
#    new app icon immediately, no logout required. Best-effort.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

exit 0
