import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export function readConfigFile(filePath: string): string {
  if (!existsSync(filePath)) return ''
  return readFileSync(filePath, 'utf-8')
}

export function writeConfigFile(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}
