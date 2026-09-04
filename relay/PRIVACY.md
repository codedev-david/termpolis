# Relay privacy

The Termpolis relay forwards bytes between your desktop and your phone. It is a
postbox, not a participant. This document says exactly what it can see, because
"we take your privacy seriously" is not a technical claim and this is.

## What the relay can see

- **The pairing id.** A 128-bit random value minted on your desktop when you
  pair a phone. It identifies a room. It is not derived from your account, your
  machine, your key, or anything else about you, and it changes every time you
  re-pair.
- **Frame sizes and timing.** How many bytes crossed, and when. Enough to know
  that something happened and roughly how much of it — not what.
- **Connection metadata.** When each side connected and disconnected, and which
  role (`desktop` or `device`) claimed each slot.
- **Source IP address**, used for the registration rate limit and discarded
  when the limit window rolls over.

## What the relay cannot see

- **Frame contents.** Every frame is sealed on the sending device and opened on
  the receiving one. The relay forwards ciphertext it has no key for.
- **Terminal output, commands, file paths, directory names, project names.**
- **Model credentials.** Your Claude, Codex, or Gemini account stays on the
  desktop. Nothing that authenticates you to a model provider is ever sent to
  the relay, in any form, sealed or otherwise.
- **Memory, embeddings, or conversation history.** Those live on the desktop
  and are not part of the remote protocol.

## Why "cannot", not "does not"

The keys are generated on your two devices and exchanged during pairing, which
happens by QR code, in person, off the network. No key material reaches the
relay at any point, so there is nothing on the relay to compel, subpoena, leak,
or misconfigure. An operator with full administrative access to the Worker, its
Durable Objects, and its logs still cannot read a frame. Neither can we.

That is a property of where the keys are, not of a policy we promise to follow.

## What is stored

Nothing. Frames are forwarded in memory and never written to disk or to any
Cloudflare storage product. A room holds two socket handles and a last-seen
timestamp per peer; when both peers leave, the room and everything in it is
gone. There is no database, no queue, no object store, and no backup.

Cloudflare's own edge logs record request metadata for their retention period,
as they do for any traffic through their network. Those logs contain the
metadata listed above and no frame bodies, because frame bodies never appear in
a log line — see `DEPLOY.md` for how logs are read.

## Safety numbers

After pairing, the desktop and phone each display an eight-word phrase derived
from both public keys. Eight words drawn from a 256-word list is 64 bits, chosen
against the cost of GRINDING a match rather than the cost of reading one aloud:
the desktop's public key is static and printed in every QR that machine shows,
so an attacker can search offline, for as long as they like, from a photograph
taken months ago. If the two phrases match, you are talking to each other.
If they do not, someone is between you — and a relay operator substituting keys
is exactly the attack that check exists to catch. Compare them once, on first
pair. This is the same construction Signal uses for its safety numbers.

## Running your own

The relay is a single Cloudflare Worker in this directory, under a hundred
lines of forwarding logic, and `DEPLOY.md` covers standing one up. If you would
rather not take the above on trust, don't: deploy it yourself and point the
desktop at your own hostname. The protocol does not care whose relay it is,
which is the point.
