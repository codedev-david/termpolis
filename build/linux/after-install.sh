#!/bin/sh
# Termpolis .deb postinst — runs after dpkg unpacks the package.
#
# Wired in via package.json -> build.deb.afterInstall. electron-builder
# copies this to DEBIAN/postinst and chmods 0755.
#
# This script does NOT resolve dependencies, and must not. It used to run
#
#     DEBIAN_FRONTEND=noninteractive apt-get install -f -y || true
#
# which is wrong twice over. dpkg holds the frontend lock for the whole
# duration of a maintainer script, so an apt-get from inside one either fails
# on the lock or re-enters dpkg while it is already running. And it was there
# to paper over a packaging bug rather than fix it: the Depends: list was
# electron-builder's default (gconf2, gconf-service, libappindicator1, ...),
# packages that no longer exist on Debian 12 / Ubuntu 22.04+, so dpkg could
# never satisfy them and every install landed in an unmet-deps state.
#
# Dependencies are now declared properly in package.json -> build.deb.depends,
# which is the only thing that lets `apt install ./termpolis_*.deb` resolve
# them the normal way, before this script ever runs.

set -e

# Refresh desktop / icon caches so the launcher and dock pick up the new app
# icon immediately, no logout required. Best-effort: both tools are absent on
# minimal installs, and a stale icon cache is not worth failing an install for.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

exit 0
