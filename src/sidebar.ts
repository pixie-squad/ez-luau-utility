import * as vscode from "vscode";

import {
  REMOTE_LOGIN_COMMAND,
  REMOTE_LOGOUT_COMMAND,
  REMOTE_SET_USER_COMMAND,
  type RemoteAccountState,
  type RemoteController
} from "./remote";
import type { RemoteScriptSummary } from "./remoteApi";

export const REMOTE_AUTH_VIEW_ID = "ezLuauUtility.remoteAuth";
export const REMOTE_SCRIPTS_VIEW_ID = "ezLuauUtility.remoteScripts";
export const REMOTE_REFRESH_COMMAND =
  "ezLuauUtility.remoteRefreshScripts";
export const REMOTE_OPEN_SCRIPT_COMMAND =
  "ezLuauUtility.remoteOpenScript";
export const REMOTE_START_BATTLE_COMMAND =
  "ezLuauUtility.remoteStartBattle";
export const REMOTE_OVERWRITE_SCRIPT_COMMAND =
  "ezLuauUtility.remoteOverwriteScript";

type SidebarTreeItem = vscode.TreeItem;

export class RemoteSidebar implements vscode.Disposable {
  private readonly accountProvider: AccountTreeProvider;
  private readonly scriptsProvider: ScriptsTreeProvider;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly remote: RemoteController) {
    this.accountProvider = new AccountTreeProvider(remote);
    this.scriptsProvider = new ScriptsTreeProvider(remote);

    this.disposables = [
      this.accountProvider,
      this.scriptsProvider,
      vscode.window.createTreeView(REMOTE_AUTH_VIEW_ID, {
        treeDataProvider: this.accountProvider,
        showCollapseAll: false
      }),
      vscode.window.createTreeView(REMOTE_SCRIPTS_VIEW_ID, {
        treeDataProvider: this.scriptsProvider,
        showCollapseAll: false,
        canSelectMany: false
      }),
      vscode.commands.registerCommand(REMOTE_REFRESH_COMMAND, () =>
        this.refresh()
      ),
      vscode.commands.registerCommand(
        REMOTE_OPEN_SCRIPT_COMMAND,
        (script: unknown) => this.openScript(script)
      ),
      vscode.commands.registerCommand(
        REMOTE_START_BATTLE_COMMAND,
        (script: unknown) => this.startBattle(script)
      ),
      vscode.commands.registerCommand(
        REMOTE_OVERWRITE_SCRIPT_COMMAND,
        (script: unknown) => this.overwriteScript(script)
      ),
      remote.onDidChangeState(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("ezLuauUtility.remote")) {
          this.refresh();
        }
      })
    ];

  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private refresh(): void {
    this.accountProvider.refresh();
    this.scriptsProvider.refresh();
  }

  private async openScript(value: unknown): Promise<void> {
    const script = parseScriptArgument(value);
    if (script === undefined) {
      await vscode.window.showErrorMessage(
        "Select a script in the ez-luau-utility sidebar to open it."
      );
      return;
    }
    await this.remote.openScript(script);
  }

  private async startBattle(value: unknown): Promise<void> {
    if (value === undefined) {
      await this.remote.startBattle();
      return;
    }

    const script = parseScriptArgument(value);
    if (script === undefined) {
      await vscode.window.showErrorMessage(
        "Select a script in the ez-luau-utility sidebar to start it."
      );
      return;
    }
    await this.remote.startBattle(script);
  }

  private async overwriteScript(value: unknown): Promise<void> {
    const script = parseScriptArgument(value);
    if (script === undefined) {
      await vscode.window.showErrorMessage(
        "Select a script in the ez-luau-utility sidebar to overwrite it."
      );
      return;
    }
    await this.remote.overwriteActiveFile(script);
  }
}

class AccountTreeProvider
  implements vscode.TreeDataProvider<SidebarTreeItem>, vscode.Disposable
{
  private readonly changeEmitter =
    new vscode.EventEmitter<SidebarTreeItem | undefined>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly remote: RemoteController) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SidebarTreeItem): Promise<SidebarTreeItem[]> {
    if (element !== undefined) {
      return [];
    }

    const state = await this.remote.getAccountState();
    if (state.username === undefined) {
      return [
        actionItem(
          "Sign in",
          "Authenticate with the scripting service",
          "sign-in",
          REMOTE_LOGIN_COMMAND
        )
      ];
    }

    return signedInItems(state);
  }
}

class ScriptsTreeProvider
  implements vscode.TreeDataProvider<SidebarTreeItem>, vscode.Disposable
{
  private readonly changeEmitter =
    new vscode.EventEmitter<SidebarTreeItem | undefined>();
  private scriptsPromise:
    | Promise<readonly RemoteScriptSummary[] | undefined>
    | undefined;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly remote: RemoteController) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.scriptsPromise = undefined;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SidebarTreeItem): Promise<SidebarTreeItem[]> {
    if (element !== undefined) {
      return [];
    }

    const state = await this.remote.getAccountState();
    const prerequisite = scriptPrerequisiteItem(state);
    if (prerequisite !== undefined) {
      return [prerequisite];
    }

    const request =
      this.scriptsPromise ??
      (this.scriptsPromise = this.remote.listScriptsForSidebar());
    const scripts = await request;
    if (this.scriptsPromise !== request) {
      return this.getChildren();
    }
    if (scripts === undefined) {
      return [
        actionItem(
          "Could not load scripts",
          "Retry loading the remote script list",
          "warning",
          REMOTE_REFRESH_COMMAND
        )
      ];
    }
    if (scripts.length === 0) {
      return [statusItem("No scripts found", "info")];
    }

    return [...scripts]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((script) => new RemoteScriptTreeItem(script));
  }
}

class RemoteScriptTreeItem extends vscode.TreeItem {
  constructor(readonly script: RemoteScriptSummary) {
    super(
      script.name.length === 0 ? "(unnamed script)" : script.name,
      vscode.TreeItemCollapsibleState.None
    );
    this.id = script.uuid;
    this.description = script.published_at === null ? "draft" : "published";
    this.tooltip = [
      script.name.length === 0 ? "(unnamed script)" : script.name,
      `UUID: ${script.uuid}`,
      `Updated: ${formatTimestamp(script.updated_at)}`,
      script.published_at === null ? "Status: Draft" : "Status: Published"
    ].join("\n");
    this.iconPath = new vscode.ThemeIcon("symbol-file");
    this.contextValue = "remoteScript";
    this.command = {
      command: REMOTE_OPEN_SCRIPT_COMMAND,
      title: "Download and Open Script",
      arguments: [script]
    };
    this.accessibilityInformation = {
      label: `${this.label}, ${this.description}`
    };
  }
}

function signedInItems(state: RemoteAccountState): SidebarTreeItem[] {
  const account = statusItem(state.username ?? "Signed in", "account");
  account.description = "signed in";
  account.contextValue = "remoteAccount";

  const user = actionItem(
    state.userUuid === undefined ? "Set scripts user UUID" : "Scripts user",
    state.userUuid === undefined
      ? "Choose which user's scripts appear in the explorer"
      : state.userUuid,
    "person",
    REMOTE_SET_USER_COMMAND
  );
  user.description = state.userUuid;

  return [
    account,
    user,
    actionItem(
      "Re-authenticate",
      "Sign in again and replace the saved credentials",
      "key",
      REMOTE_LOGIN_COMMAND
    ),
    actionItem(
      "Sign out",
      "Remove the saved credentials and session",
      "sign-out",
      REMOTE_LOGOUT_COMMAND
    )
  ];
}

function scriptPrerequisiteItem(
  state: RemoteAccountState
): SidebarTreeItem | undefined {
  if (state.username === undefined) {
    return actionItem(
      "Sign in to load scripts",
      "Authenticate with the scripting service",
      "sign-in",
      REMOTE_LOGIN_COMMAND
    );
  }
  if (state.userUuid === undefined) {
    return actionItem(
      "Set user UUID to load scripts",
      "Choose which user's scripts appear in the explorer",
      "person",
      REMOTE_SET_USER_COMMAND
    );
  }
  return undefined;
}

function actionItem(
  label: string,
  tooltip: string,
  icon: string,
  command: string
): vscode.TreeItem {
  const item = statusItem(label, icon);
  item.tooltip = tooltip;
  item.command = { command, title: label };
  item.contextValue = "remoteAction";
  return item;
}

function statusItem(label: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function parseScriptArgument(value: unknown): RemoteScriptSummary | undefined {
  const candidate =
    typeof value === "object" &&
    value !== null &&
    "script" in value
      ? value.script
      : value;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("uuid" in candidate) ||
    !("name" in candidate) ||
    typeof candidate.uuid !== "string" ||
    typeof candidate.name !== "string"
  ) {
    return undefined;
  }
  return candidate as RemoteScriptSummary;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? value : timestamp.toLocaleString();
}
