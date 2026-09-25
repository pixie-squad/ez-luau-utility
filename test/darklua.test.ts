import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveDarkluaPath } from "../src/darklua";

test("resolves bundled darklua executables for supported platforms", () => {
  const root = path.resolve("extension-root");
  assert.equal(
    resolveDarkluaPath(root, undefined, "win32", "x64"),
    path.join(root, "bin", "darklua", "win32-x64", "darklua.exe")
  );
  assert.equal(
    resolveDarkluaPath(root, "", "linux", "arm64"),
    path.join(root, "bin", "darklua", "linux-arm64", "darklua")
  );
  assert.equal(
    resolveDarkluaPath(root, undefined, "darwin", "x64"),
    path.join(root, "bin", "darklua", "darwin-x64", "darklua")
  );
});

test("ships every declared darklua binary and its license", async () => {
  const root = path.resolve(".");
  for (const [platform, architecture] of [
    ["win32", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"]
  ] as const) {
    const executable = resolveDarkluaPath(
      root,
      undefined,
      platform,
      architecture
    );
    assert.ok((await stat(executable)).size > 5_000_000);
  }

  assert.match(
    await readFile(path.join(root, "bin", "darklua", "LICENSE.txt"), "utf8"),
    /MIT License/
  );
  assert.equal(
    (await readFile(path.join(root, "bin", "darklua", "VERSION"), "utf8")).trim(),
    "v0.19.0"
  );
});

test("uses an explicit darklua override when configured", () => {
  assert.equal(
    resolveDarkluaPath("ignored", "  /tools/darklua  ", "plan9", "mips"),
    "/tools/darklua"
  );
});

test("rejects unsupported platforms without an override", () => {
  assert.throws(
    () => resolveDarkluaPath("extension-root", undefined, "freebsd", "x64"),
    /No bundled darklua executable/
  );
});
