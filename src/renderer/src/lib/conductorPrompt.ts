import { AGENT_CAPABILITIES, CATEGORY_LABELS } from './agentCapabilities'

interface ConductorPromptOptions {
  taskDescription: string
  installedAgents: Record<string, boolean>  // from detectAgents
  projectCwd: string
}

export function buildConductorPrompt(options: ConductorPromptOptions): string {
  // Build list of installed agents with their capabilities
  const agentDescriptions = AGENT_CAPABILITIES
    .filter(a => {
      // Map capability agentId to detection key
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
- swarm_list_agents: see all agent terminals
- swarm_create_task: create and assign tasks (title, description, assignTo)
- swarm_list_tasks: check task statuses
- swarm_update_task: update task status and result
- swarm_send_message: post updates (from='conductor', to='all', type='info')
- swarm_read_messages: read messages from agents
- create_terminal: create a new terminal for an agent (name, shell, cwd)
- run_command: run a command in an agent terminal
- read_output: read agent terminal output
- write_to_terminal: send text/commands to an agent terminal

INSTRUCTIONS:
1. First, post your analysis to the message bus: swarm_send_message with from='conductor', to='all', type='info', describing how you'll break down the task.
2. Analyze the task and break it into clear subtasks.
3. For each subtask, pick the best installed agent based on their strengths.
4. Create a terminal for each selected agent using create_terminal with shell='bash' and cwd='${options.projectCwd}'.
5. Wait a few seconds for shells to initialize, then start each agent by running their command via run_command (e.g., 'claude' or 'codex' or 'gemini').
6. Wait for agents to fully initialize (~15 seconds), then send each agent their task prompt via write_to_terminal.
7. Post status updates to the message bus as you go: swarm_send_message(from='conductor', to='all', type='info', content='status update...').
8. Monitor progress by periodically calling swarm_list_tasks and swarm_read_messages (every 15-20 seconds).
9. If an agent appears stuck, send guidance via write_to_terminal.
10. When all tasks are completed, post a final summary via swarm_send_message(from='conductor', to='all', type='result', content='summary...').

IMPORTANT:
- Always use from='conductor' when sending messages.
- Post regular status updates so the user can track progress in the Swarm Dashboard.
- Be decisive and efficient. Don't ask the user for input — you have full authority to assign and manage tasks.
- Each agent terminal you create should be named after the agent (e.g., "Claude Code", "Gemini CLI").

Begin now.`
}
