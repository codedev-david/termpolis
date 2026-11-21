#!/bin/sh
# Answers git for one run, and only when the prompt is for https://<the forge host Termpolis set>.
host=$TERMPOLIS_GIT_ASKPASS_HOST
[ -n "$host" ] || exit 1
# git quotes the URL it asks about: the first quote must open https:// and another must close it.
case "$1" in
  *"'"*) ;;
  *) exit 1 ;;
esac
rest=${1#*"'"}
case "$rest" in
  https://*"'"*) ;;
  *) exit 1 ;;
esac
rest=${rest#https://}
addr=${rest%%"'"*}
# A user goes before the host, never after a slash.
case "$addr" in
  */*@*) exit 1 ;;
esac
addr=${addr##*@}
addr=${addr%%/*}
[ "$addr" = "$host" ] || exit 1
case "$1" in
  Username*) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_USER" ;;
  *) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_REPLY" ;;
esac
