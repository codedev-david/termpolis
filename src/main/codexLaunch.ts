// v1.58.0 Codex effort per message: whether a Codex terminal can be pointed at Termpolis's proxy.
//
// Codex takes its base URL from `-c openai_base_url=…` (the renderer adds it to the launch command when
// terminal:create hands back a URL). It steps aside wherever the user already chose where Codex talks to:
// a top-level `openai_base_url`, `model_provider` or `profile` in the CODEX_HOME's config.toml (a profile
// may pick a provider of its own), or `chatgpt_base_url`. Only config.toml is read, never the sign-in.

import * as fs from 'fs'
import * as path from 'path'

const ROUTING_KEY = /^["']?(openai_base_url|model_provider|profile|chatgpt_base_url)["']?\s*=/

/** Does this config.toml choose Codex's endpoint, provider or profile at the top level? */
export function configSetsRouting(toml: string): boolean {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    // A table header ends the top level: keys under [profiles.x] or [model_providers.x] are only
    // definitions, used when a top-level key (caught above) selects them.
    if (line.startsWith('[')) break
    if (ROUTING_KEY.test(line)) return true
  }
  return false
}

/** Whether the CODEX_HOME's config routes Codex itself. An unreadable config (other than a missing
 *  one) counts as routing: when in doubt, Codex is launched as it is. */
export async function codexHomeRoutes(home: string, readFile: (p: string) => Promise<string> = (p) => fs.promises.readFile(p, 'utf8')): Promise<boolean> {
  try {
    return configSetsRouting(await readFile(path.join(home, 'config.toml')))
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }
}
