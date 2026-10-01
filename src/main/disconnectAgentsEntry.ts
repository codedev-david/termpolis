// Entry of resources/disconnect-agents.cjs, the .deb prerm's agent disconnect. It runs under
// ELECTRON_RUN_AS_NODE=1, so argv is [termpolis, disconnect-agents.cjs, userData?]. See
// disconnectAgentsCli.ts, and electron.vite.config.ts for the bundle.
import { runDisconnectAgentsCli } from './disconnectAgentsCli'

process.exitCode = runDisconnectAgentsCli(process.argv.slice(2), process.env)
