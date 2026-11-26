#!/bin/sh
# A stand-in git login helper for tests/fixtures/gitHttps: it logs each call's operation and
# GCM_INTERACTIVE to $FAKE_HELPER_LOG, and on `get` answers with $FAKE_HELPER_USER and
# $FAKE_HELPER_REPLY, which live only in the git run's environment. With FAKE_HELPER_EMPTY=1 it
# answers nothing, as a helper whose login is gone does. It never reads any real login store.
#
# git reads it into one shell (fakeHelperConfig: `. file` inside a function, whose $1 is the operation), and it uses
# only shell builtins, so a call starts one process, not three (sh -c, sh for the script, cat): on Windows each costs
# 0.2-1 s, more on a loaded machine, and four calls a clone made worldGitHttps miss its budgets (HOLD-B #106).
op=$1
if [ -n "$FAKE_HELPER_LOG" ]; then
  printf '%s GCM_INTERACTIVE=%s\n' "$op" "${GCM_INTERACTIVE-}" >> "$FAKE_HELPER_LOG"
fi
# git writes the request's attributes, then closes; read them all so it never blocks.
while IFS= read -r _line; do :; done
[ "$op" = get ] || exit 0
[ "${FAKE_HELPER_EMPTY-}" = 1 ] && exit 0
printf 'username=%s\n' "$FAKE_HELPER_USER"
printf 'password=%s\n' "$FAKE_HELPER_REPLY"
