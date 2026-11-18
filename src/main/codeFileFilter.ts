// Which repository files belong in a code index: no secrets (the sensitive-path rules), no binaries
// or media, no minified bundles or lock files. Pure, so the world utility process applies the same
// rule as the main-process code ingest.
import { matchSensitiveFile } from './sensitivePaths'

// Non-text / generated artifacts that pollute a code index.
const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|tar|7z|rar|exe|dll|so|dylib|node|wasm|onnx|bin|woff2?|ttf|eot|otf|mp[34]|mov|avi|webm|class|jar|pyc|map)$/i
const SKIP_NAME = /(\.min\.(js|css)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i

export function isIndexableCodeFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  if (matchSensitiveFile(filePath) !== null) return false // secrets — never index
  if (SKIP_EXT.test(filePath)) return false
  if (SKIP_NAME.test(filePath)) return false
  return true
}
