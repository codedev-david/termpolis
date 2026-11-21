// Lumopolis e2e hooks in main. Like every TERMPOLIS_TEST_* hook they are inert outside a test run
// (NODE_ENV=test), so an env var set on a user's machine can never steer the app.

/** The one gate both hooks share: in a test run, the env var `name` names a file whose trimmed text is the
 *  answer (read at each ask; empty text is a cancel, null). undefined means "no test answer: show the real
 *  dialog", and then the file is never read. */
export async function testFileAnswer(
  env: Record<string, string | undefined>,
  name: string,
  read: (file: string) => Promise<string>,
): Promise<string | null | undefined> {
  const file = env[name]
  if (env.NODE_ENV !== 'test' || !file) return undefined
  return (await read(file)).trim() || null
}

/** The Lumopolis folder picker's test answer: TERMPOLIS_TEST_WORLD_PICK_FILE names a file whose text is the
 *  folder to answer (read at each pick, so one test can pick several folders). */
export function testPickedFolder(
  env: Record<string, string | undefined>,
  read: (file: string) => Promise<string>,
): Promise<string | null | undefined> {
  return testFileAnswer(env, 'TERMPOLIS_TEST_WORLD_PICK_FILE', read)
}

/** The Lumopolis export's save-dialog test answer: TERMPOLIS_TEST_WORLD_SAVE_FILE names a file whose text is
 *  the path to save to. */
export function testSavePath(
  env: Record<string, string | undefined>,
  read: (file: string) => Promise<string>,
): Promise<string | null | undefined> {
  return testFileAnswer(env, 'TERMPOLIS_TEST_WORLD_SAVE_FILE', read)
}
