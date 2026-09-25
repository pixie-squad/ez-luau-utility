import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BundleError,
  compileBundle,
  type BundleHost,
  type DarkluaExecutor
} from "../src/compiler";
import { GENERATED_MARKER } from "../src/output";

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

  async listFiles(): Promise<readonly string[]> {
    return [...this.files.keys()];
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

test("stages buffered workspace files and bundles them with darklua", async () => {
  const host = new MemoryHost({
    "main.luau": 'return require("./value")',
    "value.luau": "return 42",
    ".luaurc": JSON.stringify({ aliases: { shared: "./shared" } }),
    "old.bundle.luau": "generated output should not be staged"
  });

  const execute: DarkluaExecutor = async (executable, args, cwd) => {
    assert.equal(executable, "custom-darklua");
    assert.equal(args[0], "process");
    assert.equal(args.at(-2), "--format");
    assert.equal(args.at(-1), "readable");

    const inputPath = args[1];
    const outputPath = args[2];
    const configIndex = args.indexOf("--config");
    assert.ok(inputPath);
    assert.ok(outputPath);
    assert.notEqual(configIndex, -1);

    assert.equal(await readFile(inputPath, "utf8"), 'return require("./value")');
    assert.equal(
      await readFile(path.join(cwd, "value.luau"), "utf8"),
      "return 42"
    );
    await assert.rejects(readFile(path.join(cwd, "old.bundle.luau"), "utf8"));

    const configPath = args[configIndex + 1];
    assert.ok(configPath);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      bundle: {
        require_mode: {
          name: "path",
          module_folder_name: "init",
          use_luau_configuration: true
        }
      },
      rules: []
    });

    await writeFile(outputPath, "return 42\n", "utf8");
    return { stdout: "", stderr: "" };
  };

  const result = await compileBundle(host.file("main.luau"), host, {
    darkluaPath: "custom-darklua",
    execute
  });

  assert.equal(result.code, `--!nocheck\n${GENERATED_MARKER}\nreturn 42\n`);
});

test("reports a missing darklua executable", async () => {
  const host = new MemoryHost({ "main.luau": "return true" });
  const error = Object.assign(new Error("spawn darklua ENOENT"), {
    code: "ENOENT"
  });

  await assert.rejects(
    compileBundle(host.file("main.luau"), host, {
      execute: async () => Promise.reject(error)
    }),
    (caught: unknown) =>
      caught instanceof BundleError &&
      caught.code === "DARKLUA_UNAVAILABLE" &&
      /configure ezLuauUtility\.darklua\.path/.test(caught.message)
  );
});

test("rejects entry files outside the workspace", async () => {
  const host = new MemoryHost({ "main.luau": "return true" });
  await assert.rejects(
    compileBundle(path.resolve("outside.luau"), host),
    (caught: unknown) =>
      caught instanceof BundleError && caught.code === "OUTSIDE_WORKSPACE"
  );
});
