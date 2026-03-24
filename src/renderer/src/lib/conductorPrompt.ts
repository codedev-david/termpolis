import { AGENT_CAPABILITIES, CATEGORY_LABELS } from './agentCapabilities'

interface ConductorPromptOptions {
  taskDescription: string
  installedAgents: Record<string, boolean>  // from detectAgents
  projectCwd: string
  shellType?: string  // 'bash' | 'powershell'
}

export function buildConductorPrompt(options: ConductorPromptOptions): string {
  const shell = options.shellType || (navigator.platform.startsWith('Win') ? 'powershell' : 'bash')

  // Build list of installed agents with their capabilities
  const agentDescriptions = AGENT_CAPABILITIES
    .filter(a => {
      if (a.agentId === 'aider-qwen') return options.installedAgents['aider-qwen']
      return options.installedAgents[a.agentId] !== false
    })
    .map(a => {
      const strengths = Object.entries(a.strengths)
        .filter(([_, score]) => score >= 4)
        .map(([cat, score]) => `${CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS]} (${score}/5)`)
        .join(', ')
      const costLabel = a.tokenCost === 'free' ? 'Free (local)' : a.tokenCost === 'low' ? 'Low cost' : a.tokenCost === 'medium' ? 'Medium cost' : 'High cost'
      const mcpNote = a.hasMcp ? 'Has MCP' : 'No MCP (use swarm bridge)'
      return `- ${a.agentName} (${a.agentId}): Strengths: ${strengths}. ${costLabel}. ${mcpNote}.`
    })
    .join('\n')

  return `You are the Swarm Conductor for Termpolis. Your job is to orchestrate a multi-agent swarm to complete the user's task.

TASK FROM USER:
${options.taskDescription}

PROJECT DIRECTORY:
${options.projectCwd}

INSTALLED AGENTS:
${agentDescriptions}

YOUR MCP TOOLS:
- swarm_send_message: post updates (from, to, type, content)
- swarm_create_task: REQUIRED — create a task record (title, description, createdBy='conductor', assignTo)
- swarm_list_tasks: check task statuses
- swarm_update_task: update a task (taskId, status, result)
- swarm_read_messages: read messages from agents
- swarm_list_agents: see running agent terminals
- create_terminal: create a new terminal (name, shell, cwd)
- run_command: run a command in a terminal (terminalId, command)
- read_output: read terminal output (terminalId)
- write_to_terminal: send text to a terminal (terminalId, text)

REQUIRED STEPS — follow in order:

STEP 1 — Analyze and post your plan:
  Call swarm_send_message(from='conductor', to='all', type='info', content='[your breakdown plan]')

STEP 2 — Create a task record for EVERY subtask BEFORE creating any terminals:
  For each subtask call swarm_create_task(title='[short name]', description='[what the agent should do]', createdBy='conductor')
  Save the returned taskId for each task — you will need it later.
  Do NOT skip this step. The user sees tasks in the dashboard.

STEP 3 — Create agent terminals:
  For each task call create_terminal(name='[Agent Role]', shell='${shell}', cwd='${options.projectCwd}')
  Name terminals by role, e.g. "Claude (Build)", "Claude (Tests)", "Gemini (Docs)".

STEP 4 — Start agents in INTERACTIVE mode:
  For each terminal call run_command(terminalId='[id]', command='[agent command]')
  IMPORTANT — use ONLY these exact commands (no flags, no -p, no --print):
    Claude Code → 'claude'
    Codex       → 'codex'
    Gemini CLI  → 'gemini'
    Aider+Qwen  → 'aider --model ollama/qwen3-coder --no-show-model-warnings'
  Never append -p or any other flag — agents must start interactively so they have full tool access (file writing, shell, etc).
  Then post a status update via swarm_send_message.

STEP 5 — Send task prompts (~15 seconds after starting agents):
  For each agent call write_to_terminal(terminalId='[id]', text='[task prompt including the taskId]\r')
  Include the taskId in the prompt so the agent knows which task to update when done.
  The prompt should instruct the agent to actually write/modify files, not just print output.

STEP 6 — Monitor progress:
  Periodically call swarm_list_tasks and swarm_read_messages (every 15-20 seconds).
  Read agent output with read_output(terminalId='[id]') to check progress.
  Post status updates via swarm_send_message as you go.
  If an agent appears stuck, send guidance via write_to_terminal.

STEP 7 — Mark tasks complete as agents finish:
  When you confirm an agent has finished its work, call:
  swarm_update_task(taskId='[id]', status='completed', result='[brief summary of what was done]')

STEP 8 — Signal swarm completion:
  When ALL tasks are completed or failed, post a final summary:
  swarm_send_message(from='conductor', to='all', type='result', content='SWARM COMPLETE: [summary of all work done]')

IMPORTANT RULES:
- ALWAYS call swarm_create_task for every subtask in STEP 2 — never skip this.
- Always use from='conductor' when sending messages.
- Be decisive. Do not ask the user for input.
- If only one agent type is installed, run multiple instances with different roles.
- NEVER use -p, --print, or pipe flags when starting agents — always interactive mode only.
- Always start agents with the exact commands listed in STEP 4, no modifications.

Begin now.`
}
