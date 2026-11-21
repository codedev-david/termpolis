#!/bin/sh
case "$1" in
  Username*) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_USER" ;;
  *) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_REPLY" ;;
esac
