// Lumopolis e2e hooks in main. Like every TERMPOLIS_TEST_* hook they are inert outside a test run
// (NODE_ENV=test), so an env var set on a user's machine can never steer the app.

/** The Lumopolis folder picker's test answer: in a test run, TERMPOLIS_TEST_WORLD_PICK_FILE names a file
 *  whose text is the folder to answer (read at each pick, so one test can pick several folders; empty
 *  text is a cancel, null). undefined means "no test answer: show the real dialog". */
export async function testPickedFolder(
  env: Record<string, string | undefined>,
  read: (file: string) => Promise<string>,
): Promise<string | null | undefined> {
  const file = env.TERMPOLIS_TEST_WORLD_PICK_FILE
  if (env.NODE_ENV !== 'test' || !file) return undefined
  return (await read(file)).trim() || null
}
