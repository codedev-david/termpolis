#!/bin/sh
# Termpolis .deb prerm: takes Termpolis back out of every user's agent configs when the
# package is removed. It is the Linux twin of the Windows uninstaller's
# `Termpolis.exe --disconnect-agents` (build/installer.nsh).
#
# Wired in via package.json -> build.deb.fpm (`--before-remove`). fpm copies this file to
# DEBIAN/prerm verbatim and chmods it 0755.
#
# It has to be the prerm, not the postrm: the disconnect needs the app's own files. It runs
# resources/disconnect-agents.cjs, which electron.vite.config.ts bundles from
# src/main/disconnectAgentsEntry.ts. That is the same disconnectAgentIntegration() that
# Settings > Agent integration > Disconnect runs. It runs in the app's Electron with
# ELECTRON_RUN_AS_NODE=1, so it needs no display, no GTK and no separate Node.
#
# dpkg calls a prerm as one of:
#     remove
#     upgrade NEW-VERSION
#     failed-upgrade OLD-VERSION NEW-VERSION
#     deconfigure in-favour PACKAGE VERSION [removing PACKAGE VERSION]
#     remove in-favour PACKAGE VERSION
# Only `remove` takes Termpolis off the machine. A purge runs it first, and `remove in-favour`
# means a conflicting package is replacing this one. An upgrade must leave the user's agents
# connected, and the in-app updater installs a new .deb as an upgrade, so every other call does
# nothing.
#
# It looks for users in /etc/passwd, plus the account that ran sudo or pkexec, which may come
# from LDAP. Each one with Termpolis's userData folder (~/.config/termpolis) gets the disconnect,
# run AS THAT USER so the configs and the ledger it rewrites keep their owner. It runs with a
# clean environment and a time limit. A variable that only lives in the user's session
# (XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME) is invisible from here, so only the default
# locations are cleaned.
#
# It checks for the folder, not for the agent-integration.json ledger inside it. Versions before
# 1.49.0 wrote agent configs without keeping a ledger, and the disconnect finds Termpolis's
# entries by what they contain, so a user who never started 1.49 is still cleaned up.
#
# A removal must never fail because of this: every problem is logged to stderr, and the script
# always exits 0. Hence `set -u` without `set -e`.
#
# Test hooks, never set by dpkg:
#     TERMPOLIS_PRERM_ROOT is prefixed to /etc/passwd and /opt/Termpolis
#         (tests/electron/linuxPrerm.test.ts, and the package-verify job in
#         .github/workflows/test.yml).
#     TERMPOLIS_PRERM_TIMEOUT is the per-user limit in seconds (default 30).

set -u

log() {
    printf 'termpolis prerm: %s\n' "$*" >&2
}

case "${1:-}" in
    remove) ;;
    *) exit 0 ;;
esac

# dpkg --force-script-chrootless is acting on another root. Those accounts are not ours to run.
if [ -n "${DPKG_ROOT:-}" ]; then
    log "DPKG_ROOT is set, so agents are not disconnected"
    exit 0
fi

root=${TERMPOLIS_PRERM_ROOT:-}
limit=${TERMPOLIS_PRERM_TIMEOUT:-30}
app=$root/opt/Termpolis
bin=$app/termpolis
script=$app/resources/disconnect-agents.cjs

if [ ! -x "$bin" ]; then
    log "$bin cannot be run, so agents are not disconnected"
    exit 0
fi
if [ ! -f "$script" ]; then
    log "$script is missing, so agents are not disconnected"
    exit 0
fi

# runuser lives in /usr/sbin, which a trimmed PATH can lack.
PATH=${PATH:+$PATH:}/usr/sbin:/usr/bin:/sbin:/bin
export PATH
runuser=$(command -v runuser) || runuser=
su=$(command -v su) || su=
timeout=$(command -v timeout) || timeout=
getent=$(command -v getent) || getent=

nl='
'
seen=$nl

# disconnect NAME HOME: run the disconnect as NAME when HOME has Termpolis's userData folder.
# Each account and each home is handled once.
disconnect() {
    name=$1
    home=$2
    case $name in ''|[+-]*) return 0 ;; esac
    case $home in /*) ;; *) return 0 ;; esac
    case $seen in *"${nl}user:$name$nl"*|*"${nl}home:$home$nl"*) return 0 ;; esac
    seen=$seen"user:$name${nl}home:$home$nl"
    userdata=$home/.config/termpolis
    [ -d "$userdata" ] || return 0

    log "disconnecting agents for $name"
    set -- env -i "HOME=$home" "USER=$name" "LOGNAME=$name" PATH=/usr/local/bin:/usr/bin:/bin \
        ELECTRON_RUN_AS_NODE=1 "$bin" "$script" "$userdata"
    # runuser first: it opens no login session. su goes through PAM's session stack, where
    # pam_systemd starts the user's systemd manager for a few seconds. The account's shell may be
    # nologin, hence su's -s /bin/sh.
    if [ -n "$runuser" ]; then
        set -- "$runuser" -u "$name" -- "$@"
    elif [ -n "$su" ]; then
        set -- "$su" -s /bin/sh -c 'exec "$@"' -- "$name" sh "$@"
    else
        log "neither runuser nor su was found, so agents are not disconnected for $name"
        return 0
    fi
    # --foreground keeps the child in dpkg's process group, so it can still write to the
    # terminal. runuser and su pass the signal on to the command.
    if [ -n "$timeout" ]; then
        set -- "$timeout" --foreground -k 5 "$limit" "$@"
    fi
    # stdin is /dev/null so the command cannot eat the rest of /etc/passwd from the loop below.
    "$@" </dev/null 1>&2
    rc=$?
    if [ "$rc" -eq 124 ] && [ -n "$timeout" ]; then
        log "disconnecting agents for $name timed out after ${limit}s"
    elif [ "$rc" -ne 0 ]; then
        log "disconnecting agents for $name failed (exit $rc)"
    fi
    return 0
}

if [ -r "$root/etc/passwd" ]; then
    while IFS=: read -r name _pw _uid _gid _gecos home _shell || [ -n "${name:-}" ]; do
        disconnect "$name" "${home:-}"
    done <"$root/etc/passwd"
fi

# The account that ran `sudo apt remove` or pkexec may not be in /etc/passwd (LDAP, SSSD).
for who in "${SUDO_USER:-}" "${PKEXEC_UID:-}"; do
    if [ -z "$who" ] || [ -z "$getent" ]; then
        continue
    fi
    entry=$("$getent" passwd "$who") || continue
    IFS=: read -r name _pw _uid _gid _gecos home _shell <<EOF
$entry
EOF
    disconnect "$name" "${home:-}"
done

exit 0
