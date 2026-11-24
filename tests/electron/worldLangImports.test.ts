import { describe, expect, it } from 'vitest'
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
    expect(scanLangImports('Main.kt', kt)).toEqual({ pkg: 'com.acme.app', refs: ['jv:com.acme.store.Repo', 'jv:com.acme.util.format'] })
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
  it('links classes, nested classes, static members, wildcards and Kotlin top-level functions through declared packages', () => {
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
      'kt/Main.kt': ['kt/Util.kt', 'src/z/Other.java', 'src/z/Strings.java', 'src/y/Repo.java']
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
