#!/usr/bin/env python3
"""Run a command under a pty and press Enter when it asks a question.

Some CLIs refuse to do anything useful without a terminal. eas-cli is one:
`promptAsync` throws outright when `!process.stdin.isTTY` (prompts.js:16), and
the iOS distribution certificate can only be created on the interactive path
(SetUpDistributionCertificate.js:41-48). So CI has to give it a real terminal
and answer the one question it asks.

The obvious `printf '\n\n\n' | script -qec ...` does not work, and fails in ways
that look like the CLI hanging rather than like a plumbing bug:

  * A burst of newlines is spent on whichever prompt is open when the child
    first reads. The pty queues input in canonical mode until then, and that
    first read drains the whole queue into one prompt. Later questions get
    nothing.
  * A feeder that stops writing to hold stdin open is never sent SIGPIPE --
    that arrives on a write -- so it sleeps out its full duration while bash
    waits for every member of the pipeline, on success exactly as on failure.

Both are timing games against a process whose output we were not reading. This
reads the output instead, and that difference is the point:

  * It answers a question because it SAW one, not because a timer elapsed.
  * It mirrors everything the child prints to stdout, so the workflow log shows
    which question was asked, what was sent, and where it stopped. A prompt this
    does not recognise appears in the log as an unanswered prompt rather than
    as silence.
  * It only ever sends Enter, so a question whose default is wrong is a visible
    failure, never a silently accepted wrong answer. Pin those away with an
    environment variable instead -- EXPO_APPLE_TEAM_TYPE is one.
  * It exits on a deadline with the child killed and the last output shown.
"""

import os
import pty
import re
import select
import signal
import sys
import time

DEADLINE = float(os.environ.get("PTY_ANSWER_TIMEOUT", "600"))
# How long the child must be quiet before its output counts as a settled
# prompt. Prompt libraries redraw as they go; answering mid-redraw races them.
IDLE = float(os.environ.get("PTY_ANSWER_IDLE", "1.0"))
# A wrong loop here would hold Enter down on a menu forever.
MAX_ANSWERS = int(os.environ.get("PTY_ANSWER_MAX", "12"))

# Matches the tail of output that is waiting on a keypress: prompts renders
# "? Question ..." and leaves the cursor there. Trailing ANSI is stripped first.
PROMPT_TAIL = re.compile(r"[?❓]\s.*$")
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-B0-9]|[\r\x07]")


def visible(text):
    return ANSI.sub("", text)


def note(msg):
    sys.stdout.write("[pty-answer] %s\n" % msg)
    sys.stdout.flush()


def main(argv):
    if not argv:
        note("no command given")
        return 2

    note("running: %s" % " ".join(argv))
    pid, fd = pty.fork()
    if pid == 0:
        # Child. A width keeps prompt redraws from wrapping into nonsense.
        os.environ.setdefault("COLUMNS", "120")
        os.environ.setdefault("LINES", "40")
        try:
            os.execvp(argv[0], argv)
        except Exception as exc:  # pragma: no cover - exec failure path
            sys.stderr.write("exec failed: %s\n" % exc)
            os._exit(127)

    start = time.time()
    tail = ""
    last_read = time.time()
    answers = 0
    saw_output = False

    while True:
        elapsed = time.time() - start
        if elapsed > DEADLINE:
            note("deadline of %.0fs reached; killing child" % DEADLINE)
            note("last output was: %r" % tail[-400:])
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            os.waitpid(pid, 0)
            return 124

        try:
            ready, _, _ = select.select([fd], [], [], 0.25)
        except (OSError, select.error):
            break

        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                # The child closed the pty. Its status is what matters now.
                break
            if not chunk:
                break
            saw_output = True
            last_read = time.time()
            text = chunk.decode("utf-8", "replace")
            sys.stdout.write(text)
            sys.stdout.flush()
            tail = (tail + text)[-4000:]
            continue

        # Nothing to read. If the child has settled on something that looks
        # like a question, answer it once.
        if not saw_output or time.time() - last_read < IDLE:
            continue

        line = visible(tail).rstrip("\n").split("\n")[-1].strip()
        if not PROMPT_TAIL.search(line):
            continue

        if answers >= MAX_ANSWERS:
            note("refusing to answer more than %d prompts; stuck on: %s"
                 % (MAX_ANSWERS, line))
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            os.waitpid(pid, 0)
            return 124

        answers += 1
        note("answering prompt %d with Enter: %s" % (answers, line))
        os.write(fd, b"\r")
        # Consume this prompt so a redraw of the same text is not answered
        # twice, and give the child a moment to move on.
        tail = ""
        last_read = time.time()

    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        code = 128 + os.WTERMSIG(status)
        note("child killed by signal %d" % os.WTERMSIG(status))
    else:
        code = os.WEXITSTATUS(status)
    note("child exited %d after %.0fs, %d prompt(s) answered"
         % (code, time.time() - start, answers))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
