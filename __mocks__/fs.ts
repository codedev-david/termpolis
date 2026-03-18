import { vi } from 'vitest'

export const existsSync = vi.fn()
export const readFileSync = vi.fn()
export const writeFileSync = vi.fn()
export const mkdirSync = vi.fn()
export const appendFileSync = vi.fn()
export const readFile = vi.fn()
export const writeFile = vi.fn()
export const mkdir = vi.fn()
export const stat = vi.fn()
export const statSync = vi.fn()
export const readdirSync = vi.fn()
export const unlinkSync = vi.fn()
export const copyFileSync = vi.fn()
export const renameSync = vi.fn()
export const createWriteStream = vi.fn()
export const createReadStream = vi.fn()
export const promises = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
}

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  readFile,
  writeFile,
  mkdir,
  stat,
  statSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  createWriteStream,
  createReadStream,
  promises,
}
