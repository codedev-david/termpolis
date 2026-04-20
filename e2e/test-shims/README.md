# Test Shims

PATH-injectable shims used by E2E swarm tests to replace real agent CLIs
(claude, codex, gemini, aider) with the mock implementations in `../mocks/`.

When an E2E test launches the Electron app with
`TERMPOLIS_TEST_SHIM_DIR=<absolute path to this dir>`, the main process
prepends this directory to every spawned PTY's `PATH`, so any invocation of
`claude` (or similar) from inside the swarm pipeline resolves to the shim
here instead of the real installed CLI.

This protects test runs on developer machines that have real Claude Code
installed — the test can never accidentally invoke the real agent.
