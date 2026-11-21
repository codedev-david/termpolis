#!/bin/sh
# Answers git for one run, and only when the prompt is for https://<the forge host Termpolis set>.
host=$TERMPOLIS_GIT_ASKPASS_HOST
[ -n "$host" ] || exit 1
# git quotes the URL it asks about: a quote opens it and a later quote closes it, or nothing is answered.
case "$1" in
  *"'"*"'"*) ;;
  *) exit 1 ;;
esac
rest=${1#*"'"}
url=${rest%"'"*}
# The URL is the text between the first and the last quote, and holds no quote of its own.
case "$url" in
  *"'"*) exit 1 ;;
  https://*) ;;
  *) exit 1 ;;
esac
addr=${url#https://}
# A user goes before the host, never after a slash, a question mark or a hash.
case "$addr" in
  *[/?#]*@*) exit 1 ;;
esac
addr=${addr%%[/?#]*}
# The host is what follows the last @ of the address.
addr=${addr##*@}
[ "$addr" = "$host" ] || exit 1
case "$1" in
  Username*) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_USER" ;;
  *) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_REPLY" ;;
esac
