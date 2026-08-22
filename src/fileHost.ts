import { realpath } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import type { BundleHost } from "./compiler";
import { preferBufferedText } from "./policies";

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

  async exists(filePath: string): Promise<boolean> {
    if ((await this.findOpenDocument(filePath)) !== undefined) {
      return true;
    }

    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
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
