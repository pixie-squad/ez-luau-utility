import path from "node:path";

import { GENERATED_MARKER, displayPath, isGeneratedBundlePath } from "./output";

export type BundleErrorCode =
  | "AMBIGUOUS_MODULE"
  | "CIRCULAR_DEPENDENCY"
  | "DYNAMIC_REQUIRE"
  | "GENERATED_DEPENDENCY"
  | "INVALID_REQUIRE"
  | "MISSING_MODULE"
  | "OUTSIDE_WORKSPACE"
  | "READ_FAILED"
  | "UNSUPPORTED_EXTENSION"
  | "UNSUPPORTED_PATH";

export class BundleError extends Error {
  readonly code: BundleErrorCode;
  readonly filePath: string;
  readonly start: number;
  readonly end: number;

  constructor(
    code: BundleErrorCode,
    message: string,
    filePath: string,
    start = 0,
    end = start,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BundleError";
    this.code = code;
    this.filePath = filePath;
    this.start = start;
    this.end = Math.max(start + 1, end);
  }
}

export interface BundleHost {
  readonly workspaceRoot: string;
  canonicalize(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
}

export interface BundleResult {
  readonly code: string;
  readonly dependencies: readonly string[];
}

interface RequireCall {
  readonly start: number;
  readonly end: number;
  readonly specifier: string;
}

interface LinkedRequire extends RequireCall {
  readonly moduleId: number;
}

interface SourceRecord {
  readonly filePath: string;
  readonly source: string;
  readonly imports: LinkedRequire[];
}

interface ModuleRecord extends SourceRecord {
  readonly id: number;
}

interface Graph {
  readonly entry: SourceRecord;
  readonly modules: ModuleRecord[];
  readonly workspaceRoot: string;
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

export async function compileBundle(
  entryPath: string,
  host: BundleHost
): Promise<BundleResult> {
  const graph = await buildGraph(entryPath, host);
  const prefix = chooseInternalPrefix([
    graph.entry.source,
    ...graph.modules.map((module) => module.source)
  ]);
  const code = emitBundle(graph, prefix);

  return {
    code,
    dependencies: graph.modules.map((module) => module.filePath)
  };
}

async function buildGraph(entryPath: string, host: BundleHost): Promise<Graph> {
  const workspaceRoot = await host.canonicalize(host.workspaceRoot);
  const canonicalEntry = await host.canonicalize(entryPath);

  if (!isWithin(workspaceRoot, canonicalEntry)) {
    throw new BundleError(
      "OUTSIDE_WORKSPACE",
      "The entry file is outside its workspace folder.",
      canonicalEntry
    );
  }

  const modules: ModuleRecord[] = [];
  const records = new Map<string, SourceRecord>();
  const moduleIds = new Map<string, number>();
  let nextModuleId = 1;
  const visiting: string[] = [];
  const visitingSet = new Set<string>();

  const loadSource = async (filePath: string): Promise<string> => {
    try {
      return await host.readText(filePath);
    } catch (error) {
      throw new BundleError(
        "READ_FAILED",
        `Unable to read ${displayPath(workspaceRoot, filePath)}: ${errorMessage(error)}`,
        filePath,
        0,
        1,
        { cause: error }
      );
    }
  };

  const visit = async (
    filePath: string,
    requestedBy?: { filePath: string; call: RequireCall }
  ): Promise<SourceRecord> => {
    const canonicalPath = await host.canonicalize(filePath);
    const existing = records.get(canonicalPath);
    if (existing !== undefined) {
      return existing;
    }

    if (visitingSet.has(canonicalPath)) {
      const cycleStart = visiting.indexOf(canonicalPath);
      const cycle = [...visiting.slice(cycleStart), canonicalPath]
        .map((item) => displayPath(workspaceRoot, item))
        .join(" -> ");
      const location = requestedBy?.call;
      throw new BundleError(
        "CIRCULAR_DEPENDENCY",
        `Circular dependency detected: ${cycle}`,
        requestedBy?.filePath ?? canonicalPath,
        location?.start ?? 0,
        location?.end ?? 1
      );
    }

    visiting.push(canonicalPath);
    visitingSet.add(canonicalPath);

    try {
      const source = await loadSource(canonicalPath);
      const calls = scanRequires(source, canonicalPath);
      const imports: LinkedRequire[] = [];

      for (const call of calls) {
        const dependencyPath = await resolveRequire(
          canonicalPath,
          call,
          workspaceRoot,
          host
        );

        if (visitingSet.has(dependencyPath)) {
          const cycleStart = visiting.indexOf(dependencyPath);
          const cycle = [...visiting.slice(cycleStart), dependencyPath]
            .map((item) => displayPath(workspaceRoot, item))
            .join(" -> ");
          throw new BundleError(
            "CIRCULAR_DEPENDENCY",
            `Circular dependency detected: ${cycle}`,
            canonicalPath,
            call.start,
            call.end
          );
        }

        let moduleId = moduleIds.get(dependencyPath);
        if (moduleId === undefined) {
          moduleId = nextModuleId;
          nextModuleId += 1;
          moduleIds.set(dependencyPath, moduleId);

          const dependency = await visit(dependencyPath, {
            filePath: canonicalPath,
            call
          });
          modules.push({ ...dependency, id: moduleId });
        }

        imports.push({ ...call, moduleId });
      }

      const record: SourceRecord = { filePath: canonicalPath, source, imports };
      records.set(canonicalPath, record);
      return record;
    } finally {
      visitingSet.delete(canonicalPath);
      visiting.pop();
    }
  };

  const entry = await visit(canonicalEntry);
  return { entry, modules: modules.sort((left, right) => left.id - right.id), workspaceRoot };
}

async function resolveRequire(
  fromPath: string,
  call: RequireCall,
  workspaceRoot: string,
  host: BundleHost
): Promise<string> {
  const specifier = call.specifier;
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) {
    throw new BundleError(
      "UNSUPPORTED_PATH",
      `Only ./ and ../ require paths are supported; received ${JSON.stringify(specifier)}.`,
      fromPath,
      call.start,
      call.end
    );
  }

  if (specifier.includes("\\") || specifier.includes("\0")) {
    throw new BundleError(
      "UNSUPPORTED_PATH",
      "Require paths must use forward slashes and cannot contain NUL bytes.",
      fromPath,
      call.start,
      call.end
    );
  }

  const unresolved = path.resolve(path.dirname(fromPath), ...specifier.split("/"));
  if (!isWithin(workspaceRoot, unresolved)) {
    throw new BundleError(
      "OUTSIDE_WORKSPACE",
      `Require path ${JSON.stringify(specifier)} leaves the workspace folder.`,
      fromPath,
      call.start,
      call.end
    );
  }

  const extension = path.extname(unresolved).toLowerCase();
  let candidates: string[];

  if (extension === ".lua" || extension === ".luau") {
    candidates = [unresolved];
  } else if (extension === "") {
    candidates = [`${unresolved}.luau`, `${unresolved}.lua`];
  } else {
    throw new BundleError(
      "UNSUPPORTED_EXTENSION",
      `Require path ${JSON.stringify(specifier)} must target a .lua or .luau file.`,
      fromPath,
      call.start,
      call.end
    );
  }

  const matches: string[] = [];
  for (const candidate of candidates) {
    if (await host.exists(candidate)) {
      matches.push(await host.canonicalize(candidate));
    }
  }

  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length === 0) {
    throw new BundleError(
      "MISSING_MODULE",
      `Cannot resolve require path ${JSON.stringify(specifier)}.`,
      fromPath,
      call.start,
      call.end
    );
  }

  if (uniqueMatches.length > 1) {
    const choices = uniqueMatches
      .map((item) => displayPath(workspaceRoot, item))
      .join(", ");
    throw new BundleError(
      "AMBIGUOUS_MODULE",
      `Require path ${JSON.stringify(specifier)} is ambiguous: ${choices}.`,
      fromPath,
      call.start,
      call.end
    );
  }

  const resolved = uniqueMatches[0];
  if (resolved === undefined) {
    throw new Error("Internal error: resolved module disappeared.");
  }

  if (!isWithin(workspaceRoot, resolved)) {
    throw new BundleError(
      "OUTSIDE_WORKSPACE",
      `Require path ${JSON.stringify(specifier)} resolves outside the workspace folder.`,
      fromPath,
      call.start,
      call.end
    );
  }

  if (isGeneratedBundlePath(resolved)) {
    throw new BundleError(
      "GENERATED_DEPENDENCY",
      "Generated .bundle.luau files cannot be used as dependencies.",
      fromPath,
      call.start,
      call.end
    );
  }

  return resolved;
}

export function scanRequires(source: string, filePath = "<source>"): RequireCall[] {
  const calls: RequireCall[] = [];
  let index = 0;

  while (index < source.length) {
    const current = source[index];
    if (current === undefined) {
      break;
    }

    if (current === "-" && source[index + 1] === "-") {
      index = skipComment(source, index);
      continue;
    }

    if (current === "\"" || current === "'") {
      index = skipShortString(source, index, current);
      continue;
    }

    if (current === "`") {
      index = skipInterpolatedString(source, index);
      continue;
    }

    if (current === "[") {
      const longStringEnd = skipLongBracket(source, index);
      if (longStringEnd !== undefined) {
        index = longStringEnd;
        continue;
      }
    }

    if (!IDENTIFIER_START.test(current)) {
      index += 1;
      continue;
    }

    const identifierStart = index;
    index += 1;
    while (index < source.length && IDENTIFIER_PART.test(source[index] ?? "")) {
      index += 1;
    }

    if (source.slice(identifierStart, index) !== "require") {
      continue;
    }

    const previous = previousNonWhitespace(source, identifierStart);
    if (previous === "." || previous === ":") {
      continue;
    }

    const afterIdentifier = skipTrivia(source, index);
    if (source[afterIdentifier] !== "(") {
      if (
        source[afterIdentifier] === "\"" ||
        source[afterIdentifier] === "'" ||
        source[afterIdentifier] === "["
      ) {
        throw new BundleError(
          "INVALID_REQUIRE",
          "Imports must use require(\"./relative/path\") syntax.",
          filePath,
          identifierStart,
          index
        );
      }
      continue;
    }

    const argumentStart = skipTrivia(source, afterIdentifier + 1);
    const quote = source[argumentStart];
    if (quote !== "\"" && quote !== "'") {
      throw new BundleError(
        "DYNAMIC_REQUIRE",
        "Require paths must be static single- or double-quoted strings.",
        filePath,
        identifierStart,
        Math.max(argumentStart + 1, index)
      );
    }

    const parsed = parseRequireString(source, argumentStart, quote, filePath);
    const closingIndex = skipTrivia(source, parsed.end);
    if (source[closingIndex] !== ")") {
      throw new BundleError(
        "INVALID_REQUIRE",
        "require() must contain exactly one static path argument.",
        filePath,
        identifierStart,
        Math.max(closingIndex + 1, parsed.end)
      );
    }

    calls.push({
      start: identifierStart,
      end: closingIndex + 1,
      specifier: parsed.value
    });
    index = closingIndex + 1;
  }

  return calls;
}

function parseRequireString(
  source: string,
  start: number,
  quote: "\"" | "'",
  filePath: string
): { value: string; end: number } {
  let index = start + 1;
  let value = "";

  while (index < source.length) {
    const current = source[index];
    if (current === quote) {
      return { value, end: index + 1 };
    }

    if (current === "\\") {
      throw new BundleError(
        "UNSUPPORTED_PATH",
        "Escapes are not supported in require paths; use forward slashes.",
        filePath,
        start,
        index + 2
      );
    }

    if (current === "\r" || current === "\n" || current === undefined) {
      break;
    }

    value += current;
    index += 1;
  }

  throw new BundleError(
    "INVALID_REQUIRE",
    "Unterminated require path string.",
    filePath,
    start,
    Math.max(start + 1, index)
  );
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const current = source[index];
    if (current !== undefined && /\s/.test(current)) {
      index += 1;
      continue;
    }

    if (current === "-" && source[index + 1] === "-") {
      index = skipComment(source, index);
      continue;
    }

    break;
  }
  return index;
}

function skipComment(source: string, start: number): number {
  if (source[start + 2] === "[") {
    const end = skipLongBracket(source, start + 2);
    if (end !== undefined) {
      return end;
    }
  }

  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipShortString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const current = source[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === quote) {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipInterpolatedString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const current = source[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === "`") {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipLongBracket(source: string, start: number): number | undefined {
  if (source[start] !== "[") {
    return undefined;
  }

  let cursor = start + 1;
  while (source[cursor] === "=") {
    cursor += 1;
  }
  if (source[cursor] !== "[") {
    return undefined;
  }

  const equalsCount = cursor - start - 1;
  const close = `]${"=".repeat(equalsCount)}]`;
  const closeIndex = source.indexOf(close, cursor + 1);
  return closeIndex === -1 ? source.length : closeIndex + close.length;
}

function previousNonWhitespace(source: string, start: number): string | undefined {
  let index = start - 1;
  while (index >= 0 && /\s/.test(source[index] ?? "")) {
    index -= 1;
  }
  return source[index];
}

function chooseInternalPrefix(sources: readonly string[]): string {
  let suffix = "";
  while (sources.some((source) => source.includes(`__luau_bundle${suffix}`))) {
    suffix += "_";
  }
  return `__luau_bundle${suffix}`;
}

function emitBundle(graph: Graph, prefix: string): string {
  const loaders = `${prefix}_loaders`;
  const values = `${prefix}_values`;
  const loaded = `${prefix}_loaded`;
  const bundledRequire = `${prefix}_require`;
  const sections: string[] = [
    "--!nocheck",
    GENERATED_MARKER,
    `-- Entry: ${displayPath(graph.workspaceRoot, graph.entry.filePath)}`,
    "",
    `local ${loaders} = {}`,
    `local ${values} = {}`,
    `local ${loaded} = {}`,
    "",
    `local function ${bundledRequire}(id)`,
    `\tif not ${loaded}[id] then`,
    `\t\t${values}[id] = ${loaders}[id]()`,
    `\t\t${loaded}[id] = true`,
    "\tend",
    `\treturn ${values}[id]`,
    "end"
  ];

  for (const module of graph.modules) {
    sections.push(
      "",
      `-- Module ${module.id}: ${displayPath(graph.workspaceRoot, module.filePath)}`,
      `${loaders}[${module.id}] = function()`,
      ensureTrailingNewline(rewriteRequires(module, bundledRequire)) + "end"
    );
  }

  sections.push(
    "",
    `-- Entry source: ${displayPath(graph.workspaceRoot, graph.entry.filePath)}`,
    rewriteRequires(graph.entry, bundledRequire)
  );

  return ensureTrailingNewline(sections.join("\n"));
}

function rewriteRequires(record: SourceRecord, bundledRequire: string): string {
  if (record.imports.length === 0) {
    return record.source;
  }

  let output = "";
  let cursor = 0;
  for (const item of record.imports) {
    output += record.source.slice(cursor, item.start);
    output += `${bundledRequire}(${item.moduleId})`;
    cursor = item.end;
  }
  output += record.source.slice(cursor);
  return output;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
