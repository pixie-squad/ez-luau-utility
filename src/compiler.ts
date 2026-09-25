import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GENERATED_MARKER, displayPath, isGeneratedBundlePath } from "./output";

export type BundleErrorCode =
  | "DARKLUA_FAILED"
  | "DARKLUA_UNAVAILABLE"
  | "OUTSIDE_WORKSPACE"
  | "READ_FAILED";

export class BundleError extends Error {
  readonly code: BundleErrorCode;
  readonly filePath: string;
  readonly start: number;
  readonly end: number;

  constructor(
    code: BundleErrorCode,
    message: string,
    filePath: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BundleError";
    this.code = code;
    this.filePath = filePath;
    this.start = 0;
    this.end = 1;
  }
}

export interface BundleHost {
  readonly workspaceRoot: string;
  canonicalize(filePath: string): Promise<string>;
  listFiles(): Promise<readonly string[]>;
  readText(filePath: string): Promise<string>;
}

export interface BundleResult {
  readonly code: string;
}

export interface DarkluaCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type DarkluaExecutor = (
  executable: string,
  args: readonly string[],
  cwd: string
) => Promise<DarkluaCommandOutput>;

export interface CompileBundleOptions {
  readonly darkluaPath?: string;
  readonly execute?: DarkluaExecutor;
}

const DARKLUA_TIMEOUT_MS = 60_000;
const DARKLUA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STAGING_PREFIX = "ez-luau-utility-darklua-";
const STAGING_CONFIG_NAME = ".darklua.ez-luau-utility.json";
const STAGING_OUTPUT_NAME = ".ez-luau-utility.bundle.luau";

export async function compileBundle(
  entryPath: string,
  host: BundleHost,
  options: CompileBundleOptions = {}
): Promise<BundleResult> {
  const workspaceRoot = await host.canonicalize(host.workspaceRoot);
  const canonicalEntry = await host.canonicalize(entryPath);

  if (!isWithin(workspaceRoot, canonicalEntry)) {
    throw new BundleError(
      "OUTSIDE_WORKSPACE",
      "The entry file is outside its workspace folder.",
      canonicalEntry
    );
  }

  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), STAGING_PREFIX));
  const stagedEntry = path.join(stagingRoot, path.relative(workspaceRoot, canonicalEntry));
  const stagedOutput = path.join(stagingRoot, STAGING_OUTPUT_NAME);
  const stagedConfig = path.join(stagingRoot, STAGING_CONFIG_NAME);

  try {
    await stageWorkspaceFiles(host, workspaceRoot, canonicalEntry, stagingRoot);
    await writeFile(
      stagedConfig,
      JSON.stringify(
        {
          bundle: {
            require_mode: {
              name: "path",
              module_folder_name: "init",
              use_luau_configuration: true
            }
          },
          rules: []
        },
        null,
        2
      ),
      "utf8"
    );

    const executable = options.darkluaPath?.trim() || "darklua";
    const execute = options.execute ?? executeDarklua;

    try {
      if (process.platform !== "win32" && path.isAbsolute(executable)) {
        await chmod(executable, 0o755).catch(() => undefined);
      }
      await execute(
        executable,
        [
          "process",
          stagedEntry,
          stagedOutput,
          "--config",
          stagedConfig,
          "--format",
          "readable"
        ],
        stagingRoot
      );
    } catch (error) {
      if (isMissingExecutable(error)) {
        throw new BundleError(
          "DARKLUA_UNAVAILABLE",
          `Could not run ${JSON.stringify(executable)}. Reinstall the extension or configure ezLuauUtility.darklua.path.`,
          canonicalEntry,
          { cause: error }
        );
      }

      throw new BundleError(
        "DARKLUA_FAILED",
        darkluaFailureMessage(error, stagingRoot, workspaceRoot),
        canonicalEntry,
        { cause: error }
      );
    }

    let output: string;
    try {
      output = await readFile(stagedOutput, "utf8");
    } catch (error) {
      throw new BundleError(
        "DARKLUA_FAILED",
        "darklua completed without producing a bundle.",
        canonicalEntry,
        { cause: error }
      );
    }

    return {
      code: `--!nocheck\n${GENERATED_MARKER}\n${output.replace(/^\uFEFF/, "")}`
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function stageWorkspaceFiles(
  host: BundleHost,
  workspaceRoot: string,
  entryPath: string,
  stagingRoot: string
): Promise<void> {
  const files = new Map<string, string>();
  for (const filePath of [...(await host.listFiles()), entryPath]) {
    const canonicalPath = await host.canonicalize(filePath);
    if (!isWithin(workspaceRoot, canonicalPath) || isGeneratedBundlePath(canonicalPath)) {
      continue;
    }
    files.set(pathKey(canonicalPath), canonicalPath);
  }

  for (const filePath of files.values()) {
    const relativePath = path.relative(workspaceRoot, filePath);
    const stagedPath = path.join(stagingRoot, relativePath);
    let contents: string;
    try {
      contents = await host.readText(filePath);
    } catch (error) {
      throw new BundleError(
        "READ_FAILED",
        `Unable to read ${displayPath(workspaceRoot, filePath)}: ${errorMessage(error)}`,
        filePath,
        { cause: error }
      );
    }

    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, contents, "utf8");
  }
}

function executeDarklua(
  executable: string,
  args: readonly string[],
  cwd: string
): Promise<DarkluaCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: DARKLUA_TIMEOUT_MS,
        maxBuffer: DARKLUA_MAX_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = new Error(error.message, { cause: error }) as Error & {
            code?: string;
            stdout?: string;
            stderr?: string;
          };
          failure.code = (error as NodeJS.ErrnoException).code;
          failure.stdout = String(stdout);
          failure.stderr = String(stderr);
          reject(failure);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function darkluaFailureMessage(
  error: unknown,
  stagingRoot: string,
  workspaceRoot: string
): string {
  const details = failureOutput(error)
    .replaceAll(stagingRoot, workspaceRoot)
    .trim();
  return details.length === 0 ? "darklua could not bundle the entry file." : details;
}

function failureOutput(error: unknown): string {
  const parts: string[] = [];
  if (typeof error === "object" && error !== null) {
    if ("stderr" in error && typeof error.stderr === "string") {
      parts.push(error.stderr);
    }
    if ("stdout" in error && typeof error.stdout === "string") {
      parts.push(error.stdout);
    }
  }
  parts.push(errorMessage(error));
  return parts.filter((part) => part.trim().length > 0).join("\n");
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
