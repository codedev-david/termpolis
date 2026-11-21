#!/bin/sh
# Answers git for one run, and only for prompts that name the forge host Termpolis set.
host=$TERMPOLIS_GIT_ASKPASS_HOST
[ -n "$host" ] || exit 1
case "$1" in
  *//"$host'"*|*//"$host/"*|*@"$host'"*|*@"$host/"*) ;;
  *) exit 1 ;;
esac
case "$1" in
  Username*) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_USER" ;;
  *) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_REPLY" ;;
esac
