import { describe, it, expect } from 'vitest'
import { extractFileTS, treeSitterSupports } from '../../src/main/codeGraphTreeSitter'
import type { FileExtract } from '../../src/main/codeGraphExtract'

const kinds = (r: FileExtract, k: string) => r.symbols.filter((s) => s.kind === k).map((s) => s.name).sort()
const sym = (r: FileExtract, n: string, k?: string) => r.symbols.find((s) => s.name === n && (!k || s.kind === k))!

describe('codeGraphTreeSitter — AST extraction', () => {
  it('supports the expected extensions', () => {
    expect(treeSitterSupports('a.ts')).toBe(true)
    expect(treeSitterSupports('a.py')).toBe(true)
    expect(treeSitterSupports('a.swift')).toBe(true)
    expect(treeSitterSupports('a.txt')).toBe(false)
    expect(treeSitterSupports('a.tf')).toBe(false) // HCL stays heuristic
  })

  it('TypeScript: symbols + AST-clean refs (method vs free; strings/comments excluded)', async () => {
    const r = await extractFileTS('a.ts', `
export class User { save() { return db.write(this) } }
export function save() { return 1 }
export function run() {
  const u = new User()
  u.save()
  save()
  const noise = "save()" // this save() in a string/comment must NOT be a ref
}
export const arrow = () => helper()
`)
    expect(r).toBeTruthy()
    expect(kinds(r!, 'class')).toEqual(['User'])
    expect(kinds(r!, 'method')).toEqual(['save'])
    expect(kinds(r!, 'function')).toEqual(['arrow', 'run', 'save'])
    const run = sym(r!, 'run', 'function')
    expect(run.refs).toContain('save')
    expect(run.refs).toContain('User')
    expect(run.refs!.filter((x) => x === 'save').length).toBe(2) // u.save() + save(), NOT the string/comment
    expect(sym(r!, 'arrow', 'function').refs).toContain('helper')
  })

  it('JavaScript', async () => {
    const r = await extractFileTS('a.js', `
class User { save() { return write(this) } }
function save() { return 1 }
const arrow = () => helper()
function run() {
  const u = new User()
  u.save()
  save()
}
`)
    expect(kinds(r!, 'class')).toEqual(['User'])
    expect(kinds(r!, 'method')).toEqual(['save'])
    expect(kinds(r!, 'function')).toEqual(['arrow', 'run', 'save'])
    expect(sym(r!, 'run', 'function').refs!.filter((x) => x === 'save').length).toBe(2)
  })

  it('Python', async () => {
    const r = await extractFileTS('a.py', `
class User:
    def save(self):
        return db.write(self)
def save():
    return 1
def run():
    u = User()
    u.save()
    save()
    s = "save()"  # noise
`)
    expect(kinds(r!, 'class')).toEqual(['User'])
    expect(kinds(r!, 'function')).toEqual(['run', 'save', 'save'])
    const run = sym(r!, 'run', 'function')
    expect(run.refs!.filter((x) => x === 'save').length).toBe(2)
    expect(run.refs).toContain('User')
  })

  it('Go', async () => {
    const r = await extractFileTS('a.go', `
package main
type User struct { name string }
func (u *User) Save() int { return write(u) }
func Save() int { return 1 }
func Run() {
	u := User{}
	u.Save()
	Save()
}
`)
    expect(kinds(r!, 'struct')).toEqual(['User'])
    expect(kinds(r!, 'function')).toEqual(['Run', 'Save'])
    expect(kinds(r!, 'method')).toEqual(['Save'])
    expect(sym(r!, 'Run', 'function').refs!.filter((x) => x === 'Save').length).toBe(2)
  })

  it('Rust', async () => {
    const r = await extractFileTS('a.rs', `
struct User { name: String }
impl User { fn save(&self) -> i32 { write(self) } }
fn save() -> i32 { 1 }
fn run() {
    let u = User {};
    u.save();
    save();
}
`)
    expect(kinds(r!, 'struct')).toEqual(['User'])
    expect(kinds(r!, 'function')).toEqual(['run', 'save', 'save'])
    expect(sym(r!, 'run', 'function').refs!.filter((x) => x === 'save').length).toBe(2)
  })

  it('Java', async () => {
    const r = await extractFileTS('A.java', `
class User { int save() { return write(this); } }
class Runner {
  int save() { return 1; }
  void run() {
    User u = new User();
    u.save();
    save();
  }
}
`)
    expect(kinds(r!, 'class')).toEqual(['Runner', 'User'])
    expect(kinds(r!, 'method')).toEqual(['run', 'save', 'save'])
    const run = sym(r!, 'run', 'method')
    expect(run.refs!.filter((x) => x === 'save').length).toBe(2)
    expect(run.refs).toContain('User')
  })

  it('C#', async () => {
    const r = await extractFileTS('A.cs', `
class User { public int Save() { return Write(this); } }
class Runner {
  public int Save() { return 1; }
  public void Run() {
    var u = new User();
    u.Save();
    Save();
  }
}
`)
    expect(kinds(r!, 'class')).toEqual(['Runner', 'User'])
    expect(kinds(r!, 'method')).toEqual(['Run', 'Save', 'Save'])
    const run = sym(r!, 'Run', 'method')
    expect(run.refs!.filter((x) => x === 'Save').length).toBe(2)
    expect(run.refs).toContain('User')
  })

  it('Ruby', async () => {
    const r = await extractFileTS('a.rb', `
class User
  def save
    write(self)
  end
end
def save
  1
end
def run
  u = User.new
  u.save
  save()
end
`)
    expect(kinds(r!, 'class')).toEqual(['User'])
    expect(kinds(r!, 'method')).toEqual(['run', 'save', 'save'])
    expect(sym(r!, 'run', 'method').refs!.filter((x) => x === 'save').length).toBe(2)
  })

  it('Swift', async () => {
    const r = await extractFileTS('a.swift', `
class User {
  func save() -> Int { return write(self) }
}
func save() -> Int { return 1 }
func run() {
  let u = User()
  u.save()
  save()
}
`)
    expect(kinds(r!, 'class')).toEqual(['User'])
    expect(kinds(r!, 'function')).toEqual(['run', 'save', 'save'])
    expect(sym(r!, 'run', 'function').refs!.filter((x) => x === 'save').length).toBe(2)
  })

  it('returns null for unsupported languages (→ heuristic fallback)', async () => {
    expect(await extractFileTS('a.txt', 'hello')).toBeNull()
    expect(await extractFileTS('main.tf', 'resource "x" "y" {}')).toBeNull()
  })

  it('is error-tolerant: still extracts the valid part of syntactically broken code', async () => {
    const r = await extractFileTS('a.ts', 'export function ok() { return 1 }\nexport function broken( { // missing paren\n')
    expect(r).toBeTruthy()
    expect(r!.symbols.some((s) => s.name === 'ok')).toBe(true)
  })

  it('handles empty and comment-only files without crashing', async () => {
    const empty = await extractFileTS('a.ts', '')
    expect(empty).toBeTruthy()
    expect(empty!.symbols).toEqual([])
    const comments = await extractFileTS('a.py', '# just a comment\n# another one')
    expect(comments!.symbols).toEqual([])
  })

  it('attributes a nested call to both the inner and enclosing symbol (safe over-approximation)', async () => {
    const r = await extractFileTS('a.ts', 'function outer() {\n  function inner() { deep() }\n  mid()\n}')
    const outer = sym(r!, 'outer', 'function')
    const inner = sym(r!, 'inner', 'function')
    expect(inner.refs).toContain('deep')
    expect(outer.refs).toContain('mid')
    expect(outer.refs).toContain('deep') // deep() is inside outer's range too — over-approx is the right bias
  })

  it('does not capture calls that live only in strings or comments', async () => {
    const r = await extractFileTS('a.ts', 'function f() {\n  // realCall()\n  const s = "alsoNotACall()"\n  actualCall()\n}')
    const f = sym(r!, 'f', 'function')
    expect(f.refs).toEqual(['actualCall'])
  })
})
