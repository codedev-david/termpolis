import { describe, expect, it } from 'vitest'
import { fill, linear, TIMED } from './_linearTime'
import { blankPython, blankRust, expandUse, goModulePath, relativeSpec, resolveLangImports, scanLangImports, type GoModule } from '../../src/main/world/langImports'
import { resolveImport } from '../../src/main/world/group'

const refs = (file: string, text: string): string[] => scanLangImports(file, text)?.refs ?? []

/** Scan every file, resolve, and read each specifier back through resolveImport to the file it names. */
function lines(project: Record<string, string>, goModules: GoModule[] = []): Record<string, string[]> {
  const files = Object.keys(project).sort()
  const scans = new Map(files.map((f) => [f, scanLangImports(f, project[f]) ?? { refs: [] }]))
  const set = new Set(files)
  const out: Record<string, string[]> = {}
  for (const [f, specs] of resolveLangImports(files, scans, goModules)) {
    out[f] = specs.map((s) => {
      const r = resolveImport(f, s, set)
      expect(r).not.toBeNull()
      return r as string
    })
  }
  return out
}

describe('scanLangImports', () => {
  it('reads nothing from a file in another language', () => {
    expect(scanLangImports('a.ts', "import x from './x'")).toBeNull()
    expect(scanLangImports('README.md', 'from .x import y')).toBeNull()
  })

  it('keeps each reference once', () => {
    expect(refs('a.py', 'import os\nimport os\n')).toEqual(['py:i:os'])
  })
})

describe('Python scan', () => {
  it('reads relative and absolute from-imports with their names, aliases and parenthesised lists', () => {
    const text = [
      'from .x import y',
      'from ..pkg import z as zed, w',
      'from . import a, b',
      'from .models import (',
      '    User,',
      '    Note as N,',
      ')',
      'from app.util import *',
      'from os.path import join; import sys',
      '  from .inner import k  # indented, in a function'
    ].join('\n')
    expect(refs('app/m.py', text)).toEqual(['py:f:.x:y', 'py:f:..pkg:z,w', 'py:f:.:a,b', 'py:f:.models:User,Note', 'py:f:app.util:', 'py:f:os.path:join', 'py:f:.inner:k', 'py:i:sys'])
  })

  it('reads plain imports, several on a line, aliases dropped', () => {
    expect(refs('m.py', 'import os, app.util as u\nimport app.store.db\n')).toEqual(['py:i:os', 'py:i:app.util', 'py:i:app.store.db'])
  })

  it('ignores imports in comments, docstrings and strings', () => {
    const text = [
      '# from .x import y',
      '"""',
      'from .docs import a',
      'import docs_mod',
      '"""',
      "'''from .single import b'''",
      "s = 'from .str import c'",
      's = "import nope"',
      'r = "a \\" from .esc import d"',
      'from .real import e'
    ].join('\n')
    expect(refs('m.py', text)).toEqual(['py:f:.real:e'])
  })

  it('skips malformed imports', () => {
    expect(refs('m.py', 'from  import x\nfrom a..b import c\nimport a..b\nimport 9x\n')).toEqual([])
  })

  it('blanks an unterminated string to the end of its line, and a triple-quoted one to the end of the file', () => {
    expect(blankPython("x = 'open\nfrom .a import b")).toBe('x =      \nfrom .a import b')
    expect(blankPython('"""never closed\nimport x')).toBe(`${' '.repeat(15)}\n${' '.repeat(8)}`)
    expect(blankPython("'a\\\nb'")).toBe('   \n  ')
  })
})

describe('Go scan', () => {
  it('reads single, grouped, aliased, dot, blank and raw-string imports after the package clause', () => {
    const text = [
      '// Package main does things.',
      '//go:build linux',
      'package main',
      '',
      'import "fmt"',
      'import str "strings"',
      'import (',
      '  "example.com/demo/server"',
      '  . "example.com/demo/util"',
      '  _ "example.com/demo/store" // side effects',
      '  m `example.com/demo/models`',
      ')',
      '',
      'func main() { _ = "example.com/demo/config" }',
      'import "late"'
    ].join('\n')
    expect(refs('main.go', text)).toEqual([
      'go:fmt',
      'go:strings',
      'go:example.com/demo/server',
      'go:example.com/demo/util',
      'go:example.com/demo/store',
      'go:example.com/demo/models'
    ])
  })

  it('ignores imports in comments and a file without a package clause', () => {
    expect(refs('a.go', 'package a\n// import "x/commented"\n/* import "x/block" */\nimport "x/real"\n')).toEqual(['go:x/real'])
    expect(refs('a.go', 'import "x"\n')).toEqual([])
  })
})

describe('Rust scan', () => {
  it('reads mod declarations, but not inline modules or ones with a path attribute', () => {
    const text = ['mod a;', 'pub mod b;', 'pub(crate) mod c ;', '#[cfg(test)] mod tests;', '#[path = "x.rs"] mod moved;', 'mod inline { }'].join('\n')
    expect(refs('src/lib.rs', text)).toEqual(['rs:m:a', 'rs:m:b', 'rs:m:c', 'rs:m:tests'])
  })

  it('reads use declarations, expanding trees and dropping the standard library', () => {
    const text = [
      'use std::io;',
      'use core::fmt;',
      'use crate::store::{Db, model::{User, Note}};',
      'pub use super::util::*;',
      'use self::inner as other;',
      '#[allow(unused)] use serde::Serialize;',
      'use crate::{',
      '    config,',
      '};'
    ].join('\n')
    expect(refs('src/lib.rs', text)).toEqual([
      'rs:u:crate::store::Db',
      'rs:u:crate::store::model::User',
      'rs:u:crate::store::model::Note',
      'rs:u:super::util',
      'rs:u:self::inner',
      'rs:u:serde::Serialize',
      'rs:u:crate::config'
    ])
  })

  it('ignores imports in comments, nested block comments, strings, raw strings and byte strings', () => {
    const text = [
      '// mod a;',
      '/* outer /* inner */ use crate::x; */',
      'let s = "use crate::y;";',
      'let r = r#"',
      'mod z;',
      '"#;',
      'let b = br"use crate::w;";',
      'let c = b"mod q;";',
      'mod real;'
    ].join('\n')
    expect(refs('src/lib.rs', text)).toEqual(['rs:m:real'])
  })

  it('tells char literals from lifetimes', () => {
    const text = "fn f<'a>(x: &'a str) -> char { let c = '\"'; let d = '\\n'; let e = '\\u{1F600}'; let h = '\\x41'; let i = b'x'; 'q' }\nmod after;"
    expect(refs('src/lib.rs', text)).toEqual(['rs:m:after'])
    expect(blankRust("'a")).toBe("'a")
  })

  it('blanks what runs to the end of the file, and keeps an r or b that is part of a name', () => {
    expect(blankRust('/* open')).toBe('       ')
    expect(blankRust('r#"open')).toBe('       ')
    expect(blankRust('"open')).toBe('     ')
    expect(blankRust('bar"x"')).toBe('bar   ')
    expect(blankRust('r = 1')).toBe('r = 1')
    expect(blankRust('"a' + String.fromCharCode(92) + '"b" x')).toBe(`${' '.repeat(7)}x`)
  })
})

describe('expandUse', () => {
  const paths = (tree: string): string[] => expandUse(tree).map((p) => p.join('::'))

  it('expands groups, nested groups, self and globs', () => {
    expect(paths('a::b')).toEqual(['a::b'])
    expect(paths('a::{self, b, c::{d, e as f}}')).toEqual(['a', 'a::b', 'a::c::d', 'a::c::e'])
    expect(paths('{a, b::*}')).toEqual(['a', 'b'])
    expect(paths('a::{b,}')).toEqual(['a::b'])
    expect(paths('*')).toEqual([''])
  })

  it('stops at a malformed tree and keeps what came before', () => {
    expect(paths('a, ::b')).toEqual(['a'])
    expect(paths('a::1')).toEqual([])
    expect(paths('a::')).toEqual([])
    expect(paths('a::{b')).toEqual(['a::b'])
    expect(paths('a b')).toEqual(['a'])
    expect(paths('')).toEqual([])
  })

  it('stops at 64 paths', () => {
    const tree = `a::{${Array.from({ length: 100 }, (_, i) => `n${i}`).join(', ')}}`
    expect(expandUse(tree)).toHaveLength(64)
  })
})

describe('Java and Kotlin scan', () => {
  it('reads the package and the imports before the first declaration', () => {
    const java = [
      '/* Licence header',
      ' * import com.fake.Header; */',
      'package com.acme.app;',
      '// import com.fake.Line;',
      'import java.util.List;',
      'import static com.acme.util.Strings.trim;',
      'import com.acme.store.*;',
      '',
      '@Service',
      'public class App {',
      '  String s = "import com.fake.Str;";',
      '}',
      'import com.late.Thing;'
    ].join('\n')
    expect(scanLangImports('App.java', java)).toEqual({ pkg: 'com.acme.app', refs: ['jv:java.util.List', 'jv:com.acme.util.Strings.trim', 'jv:com.acme.store.*'] })
    const kt = ['@file:JvmName("Main")', 'package com.acme.app', 'import com.acme.store.Repo as R', 'import com.acme.util.format', 'fun main() {}'].join('\n')
    expect(scanLangImports('Main.kt', kt)).toEqual({ pkg: 'com.acme.app', refs: ['jv:com.acme.store.Repo', 'jv:com.acme.util.format'], decls: ['main'] })
  })

  it("records a Kotlin file's top-level names, past modifiers, type parameters and receivers, and not its members", () => {
    const kt = [
      'package k',
      'fun helper(x: Int) = x',
      'private suspend fun load(): Int = 1',
      'fun <T> List<T>.second(): T = this[1]',
      'fun <K, V : Comparable<V>> Map<K, V>.top(): V? = null',
      'const val LIMIT = 3',
      'var counter: Int = 0',
      'data class User(val name: String)',
      'sealed interface Shape',
      'object Registry {',
      '  fun member() {}',
      '  val inner = 1',
      '}',
      'typealias Id = String',
      'fun interface Handler { fun handle() }',
      'fun `odd name`() {}'
    ].join('\n')
    expect(scanLangImports('U.kt', kt)?.decls).toEqual(['helper', 'load', 'second', 'top', 'LIMIT', 'counter', 'User', 'Shape', 'Registry', 'Id', 'Handler'])
    expect(scanLangImports('A.java', 'package k;\npublic class A {}')).toEqual({ pkg: 'k', refs: [] })
    expect(scanLangImports('E.kt', 'package k\nimport a.B\n')).toEqual({ pkg: 'k', refs: ['jv:a.B'] })
  })

  it('records a Kotlin class whose type parameters carry a bound, and a declaration after annotations on its line (WP7 #89 N3)', () => {
    const kt = [
      'package k',
      'class Box<T : Any>(val t: T)',
      'interface Repo<K : Comparable<K>, V> {',
      '  fun get(k: K): V',
      '}',
      'typealias Pairs<T : Any> = List<Pair<T, T>>',
      '@Serializable data class Z(val a: Int)',
      '@Ser(with = X::class) @file:Keep internal class W',
      '@JvmInline value class Id<T : Comparable<T>>(val v: T)',
      '@file:JvmName("Main")',
      '  @Inject fun member() {}'
    ].join('\n')
    expect(scanLangImports('Misc.kt', kt)?.decls).toEqual(['Box', 'Repo', 'Pairs', 'Z', 'W', 'Id'])
  })

  it('records at most 256 Kotlin top-level names', () => {
    const kt = Array.from({ length: 300 }, (_, i) => `fun f${i}() {}`).join('\n')
    const decls = scanLangImports('Many.kt', kt)?.decls ?? []
    expect(decls).toHaveLength(256)
    expect(decls[255]).toBe('f255')
  })

  it('reads a file without a package', () => {
    expect(scanLangImports('A.java', 'import x.Y;\nclass A {}')).toEqual({ refs: ['jv:x.Y'] })
  })
})

describe('goModulePath', () => {
  it('reads the module path, plain, quoted or raw, past comments', () => {
    expect(goModulePath('// module fake.com/x\nmodule example.com/demo\n\ngo 1.22\n')).toBe('example.com/demo')
    expect(goModulePath('module "example.com/q"')).toBe('example.com/q')
    expect(goModulePath('module `example.com/r`')).toBe('example.com/r')
    expect(goModulePath('go 1.22\n')).toBeNull()
  })
})

describe('relativeSpec', () => {
  it('points from one file to another the way resolveImport reads it', () => {
    expect(relativeSpec('a/b.py', 'a/c.py')).toBe('./c.py')
    expect(relativeSpec('a/b.py', 'a/d/c.py')).toBe('./d/c.py')
    expect(relativeSpec('a/b/c.py', 'a/x.py')).toBe('../x.py')
    expect(relativeSpec('a/b/c.py', 'z/x.py')).toBe('../../z/x.py')
    expect(relativeSpec('m.py', 'pkg/x.py')).toBe('./pkg/x.py')
    expect(relativeSpec('a/a/m.py', 'a/x.py')).toBe('../x.py')
  })
})

describe('Python resolution', () => {
  it('links relative imports to modules, submodules and packages', () => {
    const project = {
      'app/__init__.py': 'from .main import run\n',
      'app/main.py': 'from .service import Service\nfrom . import util, config\nfrom .db import *\n',
      'app/service.py': 'from .db.store import Store\nfrom ..outside import x\n',
      'app/util.py': '',
      'app/config.py': '',
      'app/db/__init__.py': 'from .. import util\nfrom ... import gone\n',
      'app/db/store.py': 'from .models import User\nfrom . import nothing_here\n',
      'app/db/models.py': '',
      'outside.py': 'from . import absent\nfrom .... import deep\n'
    }
    expect(lines(project)).toEqual({
      'app/__init__.py': ['app/main.py'],
      'app/main.py': ['app/service.py', 'app/util.py', 'app/config.py', 'app/db/__init__.py'],
      'app/service.py': ['app/db/store.py', 'outside.py'],
      'app/db/__init__.py': ['app/util.py'],
      'app/db/store.py': ['app/db/models.py', 'app/db/__init__.py']
    })
  })

  it('links absolute imports from the folder above the top package, the root, src/ and a script folder', () => {
    const project = {
      'svc/app/__init__.py': '',
      'svc/app/main.py': 'import app.store.db\nimport app.store.db.Thing\nfrom app.store import db\nfrom app import missing\nimport os\nimport json\n',
      'svc/app/store/__init__.py': '',
      'svc/app/store/db.py': 'import shared\n',
      'shared.py': '',
      'src/lib/__init__.py': '',
      'src/lib/core.py': '',
      'tools/run.py': 'import helper\nfrom lib import core\nimport lib.core\n',
      'tools/helper.py': ''
    }
    expect(lines(project)).toEqual({
      'svc/app/main.py': ['svc/app/store/db.py', 'svc/app/__init__.py'],
      'svc/app/store/db.py': ['shared.py'],
      'tools/run.py': ['src/lib/core.py', 'tools/helper.py']
    })
  })

  it('links nothing for the standard library or a third-party package', () => {
    expect(lines({ 'a.py': 'import os\nimport requests\nfrom django.db import models\nfrom typing import List\n' })).toEqual({})
  })
})

describe('Go resolution', () => {
  const mods: GoModule[] = [
    { dir: '', path: 'example.com/demo' },
    { dir: 'tools', path: 'example.com/demo/tools' }
  ]

  it('links module imports to every non-test file of a small package folder', () => {
    const project = {
      'go.mod': '',
      'main.go': 'package main\nimport (\n  "fmt"\n  "example.com/demo/server"\n  "example.com/demo/util"\n  "example.com/demo/empty"\n  "example.com/demo/nowhere"\n  "example.com/other/x"\n)\n',
      'server/routes.go': 'package server\nimport "example.com/demo"\n',
      'server/server.go': 'package server\n',
      'server/server_test.go': 'package server\n',
      'util/a.go': 'package util\nimport "example.com/demo/util"\n',
      'util/b.go': 'package util\n',
      'empty/only_test.go': 'package empty\n',
      'root.go': 'package main\n'
    }
    expect(lines(project, mods)).toEqual({
      'main.go': ['server/routes.go', 'server/server.go', 'util/a.go', 'util/b.go'],
      'server/routes.go': ['main.go', 'root.go'],
      'util/a.go': ['util/b.go']
    })
  })

  it('links a bigger package through one file: the one named after the folder, else the first', () => {
    const nine = (dir: string, names: string[]): Record<string, string> => Object.fromEntries(names.map((n) => [`${dir}/${n}.go`, `package ${dir}\n`]))
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const project = {
      'main.go': 'package main\nimport "example.com/demo/api"\nimport "example.com/demo/db"\n',
      ...nine('api', [...letters, 'api']),
      ...nine('db', [...letters, 'i'])
    }
    expect(lines(project, mods)).toEqual({ 'main.go': ['api/api.go', 'db/a.go'] })
  })

  it('uses the nearest go.mod: a nested module owns its folders', () => {
    const project = {
      'main.go': 'package main\nimport "example.com/demo/tools/gen"\nimport "example.com/demo/tools"\n',
      'tools/gen/gen.go': 'package gen\nimport "example.com/demo/tools/lint"\n',
      'tools/lint/lint.go': 'package lint\n',
      'tools/tools.go': 'package tools\n'
    }
    // main.go names example.com/demo/tools/gen: the longest module path is the tools module, so the folder is tools/gen.
    expect(lines(project, mods)).toEqual({
      'main.go': ['tools/gen/gen.go', 'tools/tools.go'],
      'tools/gen/gen.go': ['tools/lint/lint.go']
    })
    // Without the tools go.mod known, the root module would claim the folder; a nested go.mod at tools/gen stops that.
    expect(lines({ 'main.go': 'package main\nimport "example.com/demo/tools/gen"\n', 'tools/gen/gen.go': 'package gen\n' }, [mods[0], { dir: 'tools/gen', path: 'example.com/gen' }])).toEqual({})
  })

  it('links nothing without a go.mod', () => {
    expect(lines({ 'main.go': 'package main\nimport "example.com/demo/server"\n', 'server/server.go': 'package server\n' })).toEqual({})
  })
})

describe('Rust resolution', () => {
  it('links mod declarations to x.rs or x/mod.rs, from crate roots, mod.rs files and named modules', () => {
    const project = {
      'src/lib.rs': 'mod a;\nmod b;\nmod missing;\n',
      'src/a.rs': 'mod inner;\n',
      'src/a/inner.rs': '',
      'src/b/mod.rs': 'mod c;\n',
      'src/b/c.rs': '',
      'src/bin/tool.rs': 'mod helper;\n',
      'src/bin/helper.rs': '',
      'tests/it.rs': 'mod common;\n',
      'tests/common/mod.rs': ''
    }
    expect(lines(project)).toEqual({
      'src/lib.rs': ['src/a.rs', 'src/b/mod.rs'],
      'src/a.rs': ['src/a/inner.rs'],
      'src/b/mod.rs': ['src/b/c.rs'],
      'src/bin/tool.rs': ['src/bin/helper.rs'],
      'tests/it.rs': ['tests/common/mod.rs']
    })
  })

  it('links crate, super, self and plain use paths to the deepest module file they name', () => {
    const project = {
      'src/main.rs': 'mod net;\nuse crate::net::http::Client;\nuse crate::Thing;\nuse self::net;\nuse super::nope;\nuse serde::Deserialize;\nuse net::http;\n',
      'src/net/mod.rs': 'pub mod http;\nuse super::Config;\nuse super::super::Over;\n',
      'src/net/http.rs': 'use super::*;\nuse super::super::Root;\nuse super::super::super::Gone;\nuse crate::net::http::self_ref;\nuse self::Item;\n',
      'src/net/http/tls.rs': 'use super::Client;\n',
      'src/config.rs': ''
    }
    expect(lines(project)).toEqual({
      'src/main.rs': ['src/net/mod.rs', 'src/net/http.rs'],
      'src/net/mod.rs': ['src/net/http.rs', 'src/main.rs'],
      'src/net/http.rs': ['src/net/mod.rs', 'src/main.rs'],
      'src/net/http/tls.rs': ['src/net/http.rs']
    })
  })

  it('links nothing for crate paths outside any crate, and stops super at the top of the tree', () => {
    expect(lines({ 'loose/a.rs': 'use crate::b;\nuse super::super::super::x;\n', 'loose/b.rs': '', 'loose/sub/c.rs': 'use super::Item;\n' })).toEqual({})
    expect(lines({ 'a.rs': 'use super::super::b;\n', 'b.rs': '' })).toEqual({})
  })
})

describe('Java and Kotlin resolution', () => {
  it('links classes, nested classes, static members, wildcards and Kotlin top-level functions through declared packages, and nothing for names no file declares', () => {
    const project = {
      // Folders that do not match the packages: only the declarations count.
      'src/x/App.java': 'package com.acme.app;\nimport com.acme.store.Repo;\nimport com.acme.store.Repo.Entry;\nimport static com.acme.util.Strings.trim;\nimport com.acme.model.*;\nimport java.util.List;\nimport com.acme.app.App;\nclass App {}',
      'src/y/Repo.java': 'package com.acme.store;\nimport com.acme.util.*;\nimport com.acme.util.Strings.*;\nimport com.acme.none.*;\nclass Repo {}',
      'src/z/Strings.java': 'package com.acme.util;\nclass Strings {}',
      'src/z/Other.java': 'package com.acme.util;\nclass Other {}',
      'src/m/Model.java': 'package com.acme.model;\nclass Model {}',
      'src/m/User.java': 'package com.acme.model;\nclass User {}',
      'kt/Main.kt': 'package com.acme.app\nimport com.acme.util.format\nimport com.acme.store.Missing\nimport com.acme.ghost.Thing\nfun main() {}',
      'kt/Util.kt': 'package com.acme.util\nfun format() {}'
    }
    expect(lines(project)).toEqual({
      'src/x/App.java': ['src/y/Repo.java', 'src/z/Strings.java', 'src/m/Model.java', 'src/m/User.java'],
      'src/y/Repo.java': ['kt/Util.kt', 'src/z/Other.java', 'src/z/Strings.java'],
      // format is declared by Util.kt; Missing and ghost.Thing are declared nowhere, so they draw nothing.
      'kt/Main.kt': ['kt/Util.kt']
    })
  })

  it('draws nothing for a class no project file declares, never the whole package', () => {
    const pkg = { 'a/One.java': 'package com.a;\nclass One {}', 'a/Two.java': 'package com.a;\nclass Two {}' }
    expect(lines({ ...pkg, 'App.java': 'import com.a.Missing;\nclass App {}' })).toEqual({})
    expect(lines({ ...pkg, 'App.java': 'import static com.a.Missing.call;\nclass App {}' })).toEqual({})
    expect(lines({ ...pkg, 'App.kt': 'import com.a.Missing\nfun app() {}' })).toEqual({})
    // A wildcard still reaches the package as a whole.
    expect(lines({ ...pkg, 'App.java': 'import com.a.*;\nclass App {}' })).toEqual({ 'App.java': ['a/One.java', 'a/Two.java'] })
  })

  it('links a Kotlin top-level name to the file that declares it, and only that file', () => {
    const project = {
      'k/Utils.kt': 'package k\nfun helper() = 1\nval shared = 2',
      'k/Other.kt': 'package k\nfun other() = 3',
      'k/Named.kt': 'package k\nclass Named\nfun helper2() = 4',
      'k/Helper2.kt': 'package k\nclass Helper2',
      'App.kt': 'import k.helper\nimport k.shared\nimport k.Nope\nfun app() {}',
      'Two.kt': 'import k.helper2\nimport k.Helper2\nfun two() {}',
      'Main.java': 'import static k.UtilsKt.helper;\nimport k.helper;\nclass Main {}'
    }
    expect(lines(project)).toEqual({
      'App.kt': ['k/Utils.kt'],
      // The file named after the class wins over a top-level name; helper2 is Named.kt's.
      'Two.kt': ['k/Named.kt', 'k/Helper2.kt'],
      'Main.java': ['k/Utils.kt']
    })
  })
})

describe('resolveLangImports', () => {
  it('links a wildcard over a bigger package through the file named after it', () => {
    const project: Record<string, string> = { 'App.java': 'import com.acme.web.*;\nclass App {}' }
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Web']) project[`web/${n}.java`] = `package com.acme.web;\nclass ${n} {}`
    expect(lines(project)).toEqual({ 'App.java': ['web/Web.java'] })
  })


  it('ignores an unknown tag and files without a scan', () => {
    expect(resolveLangImports(['a.py', 'b.py'], new Map([['a.py', { refs: ['zz:b'] }]]), [])).toEqual(new Map())
  })
})

describe('Rust attributes on the lines above a mod', () => {
  it('skips a mod whose #[path] sits on its own line above it, as rustfmt writes it', () => {
    expect(refs('src/lib.rs', '#[path = "x.rs"]\nmod moved;\nmod kept;\n')).toEqual(['rs:m:kept'])
    expect(refs('src/lib.rs', '  #[path = "x.rs"]\n  pub mod moved;\n')).toEqual([])
  })

  it('looks past blank lines, comments, doc comments and other attributes, inner ones included', () => {
    const text = ['#[path = "a.rs"]', '#[cfg(test)]', '', '// a note', '/// docs', '/* block */', '#[allow(dead_code)] mod moved;', '#![allow(unused)]', '#[cfg(unix)]', 'mod kept;'].join('\n')
    expect(refs('src/lib.rs', text)).toEqual(['rs:m:kept'])
    expect(refs('src/lib.rs', '#![path = "x.rs"]\nmod moved;')).toEqual([])
  })

  it('stops at the item above, a bracket that is no attribute, and its bounds', () => {
    expect(refs('src/lib.rs', '#[derive(Debug)]\nstruct S;\nmod after;')).toEqual(['rs:m:after'])
    expect(refs('src/lib.rs', 'const A: [u8; 1] = [1];\nmod after;')).toEqual(['rs:m:after'])
    expect(refs('src/lib.rs', 'fn f() { let a = [1]; }\nmod after;')).toEqual(['rs:m:after'])
    // Brackets inside an attribute no longer end it (WP7 #89 N2): this is a path attribute, so the mod is not followed.
    expect(refs('src/lib.rs', '#[path = x([1])]\nmod nested;')).toEqual([])
    expect(refs('src/lib.rs', ']\nmod a;')).toEqual(['rs:m:a'])
    expect(refs('src/lib.rs', '[a]\nmod b;')).toEqual(['rs:m:b'])
    // Seventeen attributes up, past the bound of sixteen; more than a thousand characters of blank lines or of one
    // attribute away.
    expect(refs('src/lib.rs', '#[path = "x.rs"]\n' + '#[a]\n'.repeat(16) + 'mod far;')).toEqual(['rs:m:far'])
    expect(refs('src/lib.rs', '#[path = "x.rs"]\n' + '\n'.repeat(1001) + 'mod far;')).toEqual(['rs:m:far'])
    expect(refs('src/lib.rs', '#[path = "' + 'x'.repeat(1001) + '"]\nmod far;')).toEqual(['rs:m:far'])
  })

  it('reads past an attribute that holds brackets of its own, as `#[cfg(any(a, b[0]))]` (WP7 #89 N2)', () => {
    expect(refs('src/lib.rs', '#[path = "x.rs"]\n#[cfg(any(a, b[0]))]\nmod p;\nmod q;')).toEqual(['rs:m:q'])
    expect(refs('src/lib.rs', '#[path = "x.rs"]\n#[cfg(x[y[0]][1])]\n#[doc = "]"]\nmod p;')).toEqual([])
    expect(refs('src/lib.rs', '#[cfg(any(a, b[0]))]\nmod p;')).toEqual(['rs:m:p'])
    // Brackets that never open an attribute stop the walk, as before.
    expect(refs('src/lib.rs', '#[path = "x.rs"]\n[[a]\nmod b;')).toEqual(['rs:m:b'])
    expect(refs('src/lib.rs', '#[path = "x.rs"]\nlet a = [b[0]];\nmod c;')).toEqual(['rs:m:c'])
  })
})

describe('byte-order marks and CRLF line endings', () => {
  it('reads past a leading byte-order mark in every language and in go.mod', () => {
    expect(refs('a.py', '﻿import b\nfrom . import c')).toEqual(['py:f:.:c', 'py:i:b'])
    expect(refs('a.go', '﻿package a\nimport "m/b"')).toEqual(['go:m/b'])
    expect(refs('src/lib.rs', '﻿mod a;\nuse crate::b;')).toEqual(['rs:m:a', 'rs:u:crate::b'])
    expect(scanLangImports('A.java', '﻿package a;\nimport b.C;\nclass A {}')).toEqual({ pkg: 'a', refs: ['jv:b.C'] })
    expect(scanLangImports('A.kt', '﻿package a\nimport b.C\nfun f() {}')).toEqual({ pkg: 'a', refs: ['jv:b.C'], decls: ['f'] })
    expect(goModulePath('﻿module example.com/m\n')).toBe('example.com/m')
  })

  it('reads CRLF files as it reads LF ones', () => {
    const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'
    expect(refs('a.py', crlf(['from . import (b,', '    c)', 'from .d import e', 'import f, g']))).toEqual(refs('a.py', crlf(['from . import (b,', '    c)', 'from .d import e', 'import f, g']).replace(/\r/g, '')))
    expect(refs('a.py', crlf(['from .d import e', 'import f']))).toEqual(['py:f:.d:e', 'py:i:f'])
    expect(refs('a.go', crlf(['package a', 'import (', '\t"m/b"', '\tx "m/c"', ')']))).toEqual(['go:m/b', 'go:m/c'])
    expect(refs('src/lib.rs', crlf(['#[path = "x.rs"]', 'mod moved;', 'mod a;', 'use crate::{b, c};']))).toEqual(['rs:m:a', 'rs:u:crate::b', 'rs:u:crate::c'])
    expect(scanLangImports('A.java', crlf(['package a;', 'import b.C;', 'class A {}']))).toEqual({ pkg: 'a', refs: ['jv:b.C'] })
    expect(scanLangImports('A.kt', crlf(['package a', 'import b.C', 'fun f() {}']))).toEqual({ pkg: 'a', refs: ['jv:b.C'], decls: ['f'] })
    expect(goModulePath('module example.com/m\r\n\r\ngo 1.22\r\n')).toBe('example.com/m')
  })
})

describe('hostile input stays linear', TIMED, () => {
  // Each input is read at n and 8n characters, and the larger must take under 24 times as long: a quadratic rule takes
  // about 64 (see _linearTime). Each rule guarded here took seconds at these sizes before its fix.
  const N = 64 * 1024
  // What is timed, and what is then asserted on its result once, outside the timed runs.
  interface Probe<R> { read: (src: string) => R; check: (result: R) => void }
  const grows = <R>(make: (n: number) => string, probe: Probe<R>, label = ''): void => linear(make, probe.read, N, label, probe.check)
  const reads = (file: string, want: string[]): Probe<string[]> => ({ read: (src) => refs(file, src), check: (found) => expect(found).toEqual(want) })

  it('reads an unclosed parenthesised Python list as its first line, without searching ahead from every one', () => {
    // 32,000 unclosed lists: the old bounded `\([^)]{0,4000}\)` searched 4,000 characters ahead from each one.
    grows((n) => fill('from a import (\n', n), reads('a.py', ['py:f:a:']))
    expect(refs('a.py', 'from a import (x,\n' + 'y = 1\n'.repeat(1000) + 'from b import (c,\n  d)\n')).toEqual(['py:f:a:x', 'py:f:b:c,d'])
  })

  // One test per input, so each stays well inside the test timeout on a loaded runner with coverage on.
  it.each<[string, (n: number) => string, string[]]>([
    ['"use a" lines', (n) => fill('use a\n', n), []],
    ['"]" then "mod x;" lines', (n) => fill(']\nmod x;\n', n), ['rs:m:x']],
    ['"#[a]" lines then "mod x;"', (n) => fill('#[a]\n', n) + 'mod x;', ['rs:m:x']],
    ['"#[a[0]]" lines then "mod x;"', (n) => fill('#[a[0]]\n', n) + 'mod x;', ['rs:m:x']],
    ['a "]" run then "mod x;"', (n) => fill(']', n) + '\nmod x;', ['rs:m:x']]
  ])('reads a Rust use with no `;` in reach as nothing, in linear time (%s)', (label, make, want) => grows(make, reads('src/lib.rs', want), label))

  it('reads a Rust use with no `;` in reach as nothing, and the next one', () => {
    expect(refs('src/lib.rs', 'use crate::a::b\n' + 'x'.repeat(2001) + ';\nuse crate::c;')).toEqual(['rs:u:crate::c'])
  })

  // The two `[ \t]+` around an empty module split the run every way: 2.3 s on main for 50k spaces.
  it.each<[string, (n: number) => string]>([
    ['spaces', (n) => 'from' + ' '.repeat(n)],
    ['spaces then import', (n) => 'from' + ' '.repeat(n) + 'import x'],
    ['tabs', (n) => 'from' + fill('\t \t', n) + '\n'],
    ['lines', (n) => fill('from \n', n)]
  ])('reads `from` followed by a long run of %s as nothing, in linear time', (label, make) => grows(make, reads('a.py', []), label))

  it('keeps relative and spaced `from` forms', () => {
    expect(refs('a.py', 'from\t \tos.path   import  join\nfrom . import b\nfrom ..pkg import (c,\n  d)\nfrom\t.x import y\n')).toEqual(['py:f:os.path:join', 'py:f:.:b', 'py:f:..pkg:c,d', 'py:f:.x:y'])
    // A `from` with no module no longer swallows the lines of its `(` list: the import under it is read.
    expect(refs('a.py', 'from  import (\nimport os\n)\n')).toEqual(['py:i:os'])
  })

  it("bounds a Kotlin file's declaration scan on one long line", () => {
    const none: Probe<unknown> = { read: (src) => scanLangImports('a.kt', src), check: (found) => expect(found).toEqual({ refs: [] }) }
    grows((n) => 'fun ' + 'a'.repeat(n), none)
    grows((n) => 'fun <' + '<'.repeat(n), none)
    grows((n) => 'class A<' + '<'.repeat(n), none)
    grows((n) => 'class A' + fill('<B>', n), none)
    grows((n) => fill('@a ', n), none)
    grows((n) => fill('@a(b) ', n) + '\n', none)
  })

  // The spaces after the keyword were shared with the head, so about 200 starts each rescanned a long `<...>` part:
  // 115 ms on a file at the snapshot cap, 18 times a plain line of its length (minors review m6). On main, and now, it
  // takes what the plain line takes (about 6 ms). Both are timed in turn, best of seven, so a loaded runner slows both.
  it('reads a Kotlin keyword, a run of spaces and a long `<<` head as fast as a plain line of its length, as main did', () => {
    const N = 512 * 1024
    const hostile = 'class' + ' '.repeat(199) + '<<' + 'a'.repeat(N) + '>><'
    const plain = 'class' + ' '.repeat(199) + 'a'.repeat(N + 5)
    expect(plain.length).toBe(hostile.length)
    const best = { hostile: Infinity, plain: Infinity }
    for (let k = 0; k < 7; k++) {
      for (const [name, src] of [['hostile', hostile], ['plain', plain]] as const) {
        const t = performance.now()
        scanLangImports('a.kt', src)
        best[name] = Math.min(best[name], performance.now() - t)
      }
    }
    expect(best.hostile).toBeLessThan(3 * best.plain + 2)
    grows((n) => 'class' + ' '.repeat(199) + '<<' + 'a'.repeat(n) + '>><', { read: (x) => scanLangImports('a.kt', x), check: () => undefined })
    // The names around it are read as before.
    expect(scanLangImports('a.kt', 'class   <T> Box\nclass Box2<T : Any>\n@Ser data class Z\n')).toEqual({ refs: [], decls: ['Box', 'Box2', 'Z'] })
  })
})
