/** Where the swarm conductor's run script records, before it starts claude, the session it starts
 *  it under and the CLAUDE_CONFIG_DIR claude gets from its shell ('' when it has none): one per
 *  line. Claude Code keeps that session's transcript under that config home, which the shell's
 *  profile or a command typed before the run can set, so main can't tell it from its own
 *  environment. The file is in the home folder, beside the task file and the run script. */
export const CONDUCTOR_CLAUDE_HOME_FILE = '.termpolis-conductor-claude-home'
