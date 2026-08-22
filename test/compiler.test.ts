import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  BundleError,
  type BundleHost,
  compileBundle,
  scanRequires
} from "../src/compiler";

class MemoryHost implements BundleHost {
  readonly workspaceRoot: string;
  private readonly files = new Map<string, string>();

  constructor(files: Record<string, string>) {
    this.workspaceRoot = path.resolve("virtual-workspace");
    for (const [relativePath, contents] of Object.entries(files)) {
      this.files.set(this.key(this.file(relativePath)), contents);
    }
  }

  file(relativePath: string): string {
    return path.resolve(this.workspaceRoot, relativePath);
  }

  async canonicalize(filePath: string): Promise<string> {
    return path.resolve(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(this.key(filePath));
  }

  async readText(filePath: string): Promise<string> {
    const contents = this.files.get(this.key(filePath));
    if (contents === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return contents;
  }

  private key(filePath: string): string {
    const normalized = path.normalize(path.resolve(filePath));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
}

test("bundles a relative module and rewrites the require call", async () => {
  const host = new MemoryHost({
    "main.luau": [
      "local before = server.tick",
      'local Collision = require("./utils/collision")',
      "return Collision"
    ].join("\n"),
    "utils/collision.luau": [
      "local Collision = {}",
      "Collision.name = \"collision-module\"",
      "return Collision"
    ].join("\n")
  });

  const result = await compileBundle(host.file("main.luau"), host);

  assert.equal(result.dependencies.length, 1);
  assert.match(result.code, /-- Module 1: utils\/collision\.luau/);
  assert.match(result.code, /local Collision = __luau_bundle_require\(1\)/);
  assert.doesNotMatch(result.code, /require\("\.\/utils\/collision"\)/);
  assert.ok(result.code.indexOf("local before") < result.code.lastIndexOf("_require(1)"));
});

test("deduplicates a nested diamond dependency graph", async () => {
  const host = new MemoryHost({
    "main.luau": [
      'local A = require("./a")',
      'local B = require("./b")',
      "return { A, B }"
    ].join("\n"),
    "a.luau": 'local Shared = require("./shared")\nreturn { side = "a", Shared = Shared }',
    "b.luau": 'local Shared = require("./shared")\nreturn { side = "b", Shared = Shared }',
    "shared.luau": 'return { marker = "only-once-marker" }'
  });

  const result = await compileBundle(host.file("main.luau"), host);

  assert.equal(result.dependencies.length, 3);
  assert.equal(result.code.match(/only-once-marker/g)?.length, 1);
  assert.equal(result.code.match(/-- Module \d:/g)?.length, 3);
  assert.equal(result.code.match(/_require\(2\)/g)?.length, 2);
});

test("keeps modules lazy and preserves an entry require call's position", async () => {
  const host = new MemoryHost({
    "main.luau": 'print("before")\nlocal SideEffect = require("./side-effect")\nprint("after")',
    "side-effect.luau": 'print("module-ran")\nreturn true'
  });

  const result = await compileBundle(host.file("main.luau"), host);
  const entryStart = result.code.indexOf("-- Entry source:");
  const entry = result.code.slice(entryStart);

  assert.ok(result.code.indexOf('print("module-ran")') < entryStart);
  assert.ok(entry.indexOf('print("before")') < entry.indexOf("_require(1)"));
  assert.ok(entry.indexOf("_require(1)") < entry.indexOf('print("after")'));
});

test("ignores require text in comments and all ordinary string forms", async () => {
  const host = new MemoryHost({
    "main.luau": [
      '-- require("./missing-line")',
      '--[=[ require("./missing-block") ]=]',
      'local short = "require(\\\"./missing-string\\\")"',
      'local long = [=[require("./missing-long")]=]',
      'local template = `require("./missing-template")`',
      'local Real = require -- comment between tokens\n("./real")',
      "return Real"
    ].join("\n"),
    "real.luau": "return 42"
  });

  const result = await compileBundle(host.file("main.luau"), host);
  assert.deepEqual(result.dependencies, [host.file("real.luau")]);
});

test("uses collision-safe internal identifiers", async () => {
  const host = new MemoryHost({
    "main.luau": 'local __luau_bundle = "user value"\nreturn require("./dep")',
    "dep.luau": "return true"
  });

  const result = await compileBundle(host.file("main.luau"), host);
  assert.match(result.code, /local __luau_bundle__loaders = \{\}/);
  assert.match(result.code, /return __luau_bundle__require\(1\)/);
});

test("supports explicit .lua and .luau paths", async () => {
  const host = new MemoryHost({
    "main.luau": 'local A = require("./a.lua")\nlocal B = require("./b.luau")',
    "a.lua": "return 1",
    "b.luau": "return 2"
  });

  const result = await compileBundle(host.file("main.luau"), host);
  assert.deepEqual(result.dependencies, [host.file("a.lua"), host.file("b.luau")]);
});

test("reports dynamic requires at the call site", async () => {
  const host = new MemoryHost({ "main.luau": "local value = require(moduleName)" });

  await assert.rejects(
    compileBundle(host.file("main.luau"), host),
    (error: unknown) => error instanceof BundleError && error.code === "DYNAMIC_REQUIRE"
  );
});

test("rejects non-parenthesized import syntax", () => {
  assert.throws(
    () => scanRequires('local value = require "./module"', "main.luau"),
    (error: unknown) => error instanceof BundleError && error.code === "INVALID_REQUIRE"
  );
});

test("reports missing and ambiguous modules", async (t) => {
  await t.test("missing", async () => {
    const host = new MemoryHost({ "main.luau": 'return require("./missing")' });
    await assert.rejects(
      compileBundle(host.file("main.luau"), host),
      (error: unknown) => error instanceof BundleError && error.code === "MISSING_MODULE"
    );
  });

  await t.test("ambiguous", async () => {
    const host = new MemoryHost({
      "main.luau": 'return require("./module")',
      "module.lua": "return 1",
      "module.luau": "return 2"
    });
    await assert.rejects(
      compileBundle(host.file("main.luau"), host),
      (error: unknown) => error instanceof BundleError && error.code === "AMBIGUOUS_MODULE"
    );
  });
});

test("reports circular dependencies with the dependency chain", async () => {
  const host = new MemoryHost({
    "main.luau": 'return require("./a")',
    "a.luau": 'return require("./b")',
    "b.luau": 'return require("./a")'
  });

  await assert.rejects(compileBundle(host.file("main.luau"), host), (error: unknown) => {
    assert.ok(error instanceof BundleError);
    assert.equal(error.code, "CIRCULAR_DEPENDENCY");
    assert.match(error.message, /a\.luau -> b\.luau -> a\.luau/);
    return true;
  });
});

test("rejects workspace escapes, aliases, unsupported extensions, and generated inputs", async (t) => {
  const cases: Array<[string, string, string]> = [
    ["outside", 'return require("../outside")', "OUTSIDE_WORKSPACE"],
    ["alias", 'return require("@utils/value")', "UNSUPPORTED_PATH"],
    ["extension", 'return require("./value.json")', "UNSUPPORTED_EXTENSION"],
    ["generated", 'return require("./value.bundle.luau")', "GENERATED_DEPENDENCY"]
  ];

  for (const [name, source, expectedCode] of cases) {
    await t.test(name, async () => {
      const host = new MemoryHost({
        "main.luau": source,
        "value.json": "{}",
        "value.bundle.luau": "return true"
      });
      await assert.rejects(compileBundle(host.file("main.luau"), host), (error: unknown) => {
        return error instanceof BundleError && error.code === expectedCode;
      });
    });
  }
});
