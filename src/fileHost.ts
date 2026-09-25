import { realpath } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import type { BundleHost } from "./compiler";
import { preferBufferedText } from "./policies";

const DARKLUA_INPUT_GLOB =
  "**/*.{lua,luau,json,json5,yaml,yml,toml,txt,luaurc}";
const DARKLUA_INPUT_EXCLUDE =
  "**/{.git,node_modules,dist,build,out}/**";

export class VscodeFileHost implements BundleHost {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async canonicalize(filePath: string): Promise<string> {
    const absolutePath = path.resolve(filePath);
    try {
      return await realpath(absolutePath);
    } catch {
      return absolutePath;
    }
  }

  async listFiles(): Promise<readonly string[]> {
    const files = new Map<string, string>();
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this.workspaceRoot),
      DARKLUA_INPUT_GLOB
    );
    for (const uri of await vscode.workspace.findFiles(
      pattern,
      DARKLUA_INPUT_EXCLUDE
    )) {
      files.set(pathKey(await this.canonicalize(uri.fsPath)), uri.fsPath);
    }

    for (const document of vscode.workspace.textDocuments) {
      if (
        document.uri.scheme === "file" &&
        isWithin(this.workspaceRoot, document.uri.fsPath) &&
        /\.(?:lua|luau|json|json5|ya?ml|toml|txt|luaurc)$/i.test(
          document.uri.fsPath
        )
      ) {
        files.set(
          pathKey(await this.canonicalize(document.uri.fsPath)),
          document.uri.fsPath
        );
      }
    }

    return [...files.values()];
  }

  async readText(filePath: string): Promise<string> {
    const openDocument = await this.findOpenDocument(filePath);
    return preferBufferedText(openDocument?.getText(), async () => {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    });
  }

  async uriFor(filePath: string): Promise<vscode.Uri> {
    return (await this.findOpenDocument(filePath))?.uri ?? vscode.Uri.file(filePath);
  }

  async findOpenDocument(filePath: string): Promise<vscode.TextDocument | undefined> {
    const target = pathKey(await this.canonicalize(filePath));

    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== "file") {
        continue;
      }

      const documentPath = pathKey(await this.canonicalize(document.uri.fsPath));
      if (documentPath === target) {
        return document;
      }
    }

    return undefined;
  }
}

function pathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
