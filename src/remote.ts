import path from "node:path";

import * as vscode from "vscode";

import { AdbLaunchError, openDeeplinkWithAdb } from "./adb";
import {
  BATTLE_SETTING_GROUPS,
  BATTLE_SETTINGS,
  battleSettingValue,
  battleSettingsChangeCount,
  createBattleSettingsPayload,
  defaultBattleSettings,
  formatBattleSettingValue,
  normalizeBattleSettings,
  updateBattleSetting,
  updateDisabledBrawlerIds,
  type BattleSetting,
  type BattleSettingGroupId,
  type BattleSettingsState
} from "./battleSettings";
import { BundleError, compileBundle } from "./compiler";
import { resolveDarkluaPath } from "./darklua";
import { createScriptingDeeplink } from "./deeplink";
import { VscodeFileHost } from "./fileHost";
import {
  isGeneratedBundlePath,
  isSupportedSourcePath,
  makeOutputPath
} from "./output";
import {
  bundleUploadLabel,
  remoteUploadChoices,
  type RemoteUploadVerb
} from "./policies";
import {
  DEFAULT_COOKIE_NAME,
  DEFAULT_LOGIN_PATH,
  DEFAULT_REMOTE_BASE_URL,
  RemoteApi,
  RemoteApiError,
  RemoteOperationCancelledError,
  type LoginResult,
  type RemoteCredentials,
  type RemoteScriptSummary,
  type RemoteStore,
  type StoredRemoteSession
} from "./remoteApi";

export const REMOTE_LOGIN_COMMAND = "ezLuauUtility.remoteLogin";
export const REMOTE_LOGOUT_COMMAND = "ezLuauUtility.remoteLogout";
export const REMOTE_SET_USER_COMMAND = "ezLuauUtility.remoteSetUserUuid";
export const REMOTE_DOWNLOAD_COMMAND = "ezLuauUtility.remoteDownloadScript";
export const REMOTE_UPLOAD_COMMAND = "ezLuauUtility.remoteUploadActiveFile";
export const REMOTE_BATTLE_SETTINGS_COMMAND =
  "ezLuauUtility.remoteConfigureBattleSettings";

const CONFIGURATION_SECTION = "ezLuauUtility.remote";
const ADB_CONFIGURATION_SECTION = "ezLuauUtility.adb";
const DARKLUA_CONFIGURATION_SECTION = "ezLuauUtility.darklua";
const CREDENTIALS_SECRET_KEY = "ezLuauUtility.remote.credentials";
const SESSION_SECRET_KEY = "ezLuauUtility.remote.session";
const USER_UUID_STATE_KEY = "ezLuauUtility.remote.userUuid";
const BATTLE_SETTINGS_STATE_KEY = "ezLuauUtility.remote.battleSettings";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ScriptQuickPickItem extends vscode.QuickPickItem {
  readonly script: RemoteScriptSummary;
}

type UploadTarget =
  | { readonly kind: "create" }
  | { readonly kind: "existing"; readonly script: RemoteScriptSummary };

interface UploadTargetQuickPickItem extends vscode.QuickPickItem {
  readonly target: UploadTarget;
}

type BattleSettingsAction =
  | { readonly kind: "group"; readonly group: BattleSettingGroupId }
  | { readonly kind: "brawlers" }
  | { readonly kind: "reset" };

interface BattleSettingsQuickPickItem extends vscode.QuickPickItem {
  readonly action: BattleSettingsAction;
}

interface BattleSettingQuickPickItem extends vscode.QuickPickItem {
  readonly setting?: BattleSetting;
}

export interface RemoteAccountState {
  readonly username?: string;
  readonly userUuid?: string;
}

interface ActiveEditorContent {
  readonly content: string;
  readonly sourceLabel: string;
  readonly bundleEntry?: BundleEntry;
}

interface BundleEntry {
  readonly entryPath: string;
  readonly workspaceRoot: string;
}

interface UploadContent {
  readonly content: string;
  readonly sourceLabel: string;
}

export class RemoteController implements vscode.Disposable {
  private readonly store: VscodeRemoteStore;
  private readonly stateEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new VscodeRemoteStore(context.secrets);
  }

  dispose(): void {
    this.stateEmitter.dispose();
  }

  registerCommands(): readonly vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(REMOTE_LOGIN_COMMAND, () =>
        this.runRemote(() => this.login())
      ),
      vscode.commands.registerCommand(REMOTE_LOGOUT_COMMAND, () =>
        this.runRemote(() => this.logout())
      ),
      vscode.commands.registerCommand(REMOTE_SET_USER_COMMAND, () =>
        this.runRemote(() => this.setUserUuid())
      ),
      vscode.commands.registerCommand(REMOTE_DOWNLOAD_COMMAND, () =>
        this.runRemote(() => this.downloadScript())
      ),
      vscode.commands.registerCommand(REMOTE_UPLOAD_COMMAND, () =>
        this.runRemote(() => this.uploadActiveFile())
      ),
      vscode.commands.registerCommand(REMOTE_BATTLE_SETTINGS_COMMAND, () =>
        this.configureBattleSettings()
      )
    ];
  }

  async uploadContent(content: string, sourceLabel: string): Promise<boolean> {
    return (
      (await this.runRemote(async () => {
        const api = this.createApi();
        const target = await this.pickUploadTarget(api);
        if (target === undefined) {
          return false;
        }
        if (target.kind === "create") {
          return this.createScriptFromContent(api, content, sourceLabel);
        }
        return this.uploadContentToScript(
          api,
          target.script,
          content,
          sourceLabel,
          "Upload"
        );
      })) ?? false
    );
  }

  async getAccountState(): Promise<RemoteAccountState> {
    const credentials = await this.store.loadCredentials();
    const storedUuid = this.context.globalState.get<string>(USER_UUID_STATE_KEY);
    return {
      username: credentials?.username,
      userUuid:
        storedUuid !== undefined && UUID_PATTERN.test(storedUuid)
          ? storedUuid
          : undefined
    };
  }

  async listScriptsForSidebar(): Promise<
    readonly RemoteScriptSummary[] | undefined
  > {
    const state = await this.getAccountState();
    const userUuid = state.userUuid;
    if (state.username === undefined || userUuid === undefined) {
      return undefined;
    }

    return this.runRemote(() => this.createApi().listScripts(userUuid));
  }

  async openScript(script: RemoteScriptSummary): Promise<void> {
    await this.runRemote(() => this.downloadAndOpen(this.createApi(), script));
  }

  async startBattle(script?: RemoteScriptSummary): Promise<void> {
    const selectedScript =
      script ??
      (await this.runRemote(() => this.pickScript(this.createApi())));
    if (selectedScript === undefined) {
      return;
    }

    const deeplink = await this.runRemote(async () => {
      const configuration = vscode.workspace.getConfiguration(
        CONFIGURATION_SECTION
      );
      const baseUrl = configuration.get<string>(
        "baseUrl",
        DEFAULT_REMOTE_BASE_URL
      );
      const shareToken = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing “${selectedScript.name}” for battle…`,
          cancellable: false
        },
        () => this.createApi().createScriptShareToken(selectedScript.uuid)
      );
      return createScriptingDeeplink(
        selectedScript.uuid,
        shareToken,
        baseUrl,
        createBattleSettingsPayload(this.loadBattleSettings())
      );
    });
    if (deeplink === undefined) {
      return;
    }

    const adbPath = vscode.workspace
      .getConfiguration(ADB_CONFIGURATION_SECTION)
      .get<string>("path", "adb");

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Starting battle on the connected Android device…",
          cancellable: false
        },
        () => openDeeplinkWithAdb(deeplink, { adbPath })
      );

      if (result.kind === "launched") {
        await vscode.window.showInformationMessage(
          `Started “${selectedScript.name}” on Android device ${result.serial}.`
        );
        return;
      }

      await this.copyDeeplink(
        deeplink,
        "No authorized Android device is available through ADB. The deeplink was copied to the clipboard."
      );
    } catch (error) {
      const message =
        error instanceof AdbLaunchError
          ? error.message
          : `ADB could not start the application: ${errorMessage(error)}`;
      await this.copyDeeplink(
        deeplink,
        `${message} The deeplink was copied to the clipboard.`,
        true
      );
    }
  }

  async overwriteActiveFile(script: RemoteScriptSummary): Promise<boolean> {
    const active = await this.readActiveEditor();
    if (active === undefined) {
      return false;
    }

    return (
      (await this.runRemote(() =>
        this.uploadActiveEditorToScript(
          this.createApi(),
          script,
          active,
          "Overwrite"
        )
      )) ?? false
    );
  }

  private async login(): Promise<void> {
    const saved = await this.store.loadCredentials();
    const credentials = await this.promptForCredentials(saved?.username);
    if (credentials === undefined) {
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Signing in to the scripting API…",
        cancellable: false
      },
      () => this.createApi().login(credentials)
    );
    await this.rememberLoginUser(result);
    this.stateEmitter.fire();

    await vscode.window.showInformationMessage(
      "Signed in. Credentials were saved in VS Code Secret Storage."
    );
  }

  private async logout(): Promise<void> {
    await Promise.all([
      this.store.clearCredentials(),
      this.store.clearSession()
    ]);
    await this.context.globalState.update(USER_UUID_STATE_KEY, undefined);
    this.stateEmitter.fire();
    await vscode.window.showInformationMessage(
      "Signed out and removed the saved scripting API credentials."
    );
  }

  private async setUserUuid(): Promise<void> {
    const changed = await this.promptAndRememberUserUuid();
    if (changed !== undefined) {
      await vscode.window.showInformationMessage(
        `Remote script user set to ${changed}.`
      );
    }
  }

  private async downloadScript(): Promise<void> {
    const api = this.createApi();
    const script = await this.pickScript(api);
    if (script === undefined) {
      return;
    }

    await this.downloadAndOpen(api, script);
  }

  private async downloadAndOpen(
    api: RemoteApi,
    script: RemoteScriptSummary
  ): Promise<void> {
    const content = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading “${script.name}”…`,
        cancellable: false
      },
      () => api.getScriptContent(script.uuid)
    );
    const document = await vscode.workspace.openTextDocument({
      language: "luau",
      content
    });
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.window.showInformationMessage(
      `Downloaded “${script.name}” into an unsaved editor.`
    );
  }

  private async uploadActiveFile(): Promise<void> {
    const active = await this.readActiveEditor();
    if (active === undefined) {
      return;
    }

    await this.runRemote(async () => {
      const api = this.createApi();
      const target = await this.pickUploadTarget(api);
      if (target === undefined) {
        return false;
      }
      return target.kind === "create"
        ? this.createScriptFromActiveEditor(api, active)
        : this.uploadActiveEditorToScript(api, target.script, active, "Upload");
    });
  }

  private async readActiveEditor(): Promise<ActiveEditorContent | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      await vscode.window.showErrorMessage(
        "Open the file whose contents you want to upload."
      );
      return undefined;
    }

    const document = editor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const canBundle =
      document.uri.scheme === "file" &&
      isSupportedSourcePath(document.uri.fsPath) &&
      !isGeneratedBundlePath(document.uri.fsPath) &&
      workspaceFolder?.uri.scheme === "file";

    return {
      content: editor.document.getText(),
      sourceLabel: document.isUntitled
        ? "the active unsaved editor"
        : path.basename(document.uri.fsPath),
      bundleEntry: canBundle
        ? {
            entryPath: document.uri.fsPath,
            workspaceRoot: workspaceFolder.uri.fsPath
          }
        : undefined
    };
  }

  private async uploadActiveEditorToScript(
    api: RemoteApi,
    script: RemoteScriptSummary,
    active: ActiveEditorContent,
    confirmationLabel: RemoteUploadVerb
  ): Promise<boolean> {
    const bundleLabel = bundleUploadLabel(confirmationLabel);
    const choices = remoteUploadChoices(
      confirmationLabel,
      active.bundleEntry !== undefined
    );
    const bundleHint =
      active.bundleEntry === undefined
        ? ""
        : ` Choose ${bundleLabel} to resolve static relative requires before sending.`;
    const choice = await vscode.window.showWarningMessage(
      `Replace remote script “${script.name}” with ${active.sourceLabel} (${active.content.length.toLocaleString()} characters)?${bundleHint}`,
      { modal: true },
      ...choices
    );
    if (choice === undefined) {
      return false;
    }

    let upload: UploadContent = active;
    if (choice === bundleLabel && active.bundleEntry !== undefined) {
      const bundled = await this.bundleForUpload(
        active.bundleEntry,
        active.sourceLabel
      );
      if (bundled === undefined) {
        return false;
      }
      upload = bundled;
    } else if (choice !== confirmationLabel) {
      return false;
    }

    return this.putContent(api, script, upload.content, upload.sourceLabel);
  }

  private async createScriptFromActiveEditor(
    api: RemoteApi,
    active: ActiveEditorContent
  ): Promise<boolean> {
    const name = await this.promptForScriptName(active.sourceLabel);
    if (name === undefined) {
      return false;
    }

    const confirmationLabel: RemoteUploadVerb = "Create";
    const bundleLabel = bundleUploadLabel(confirmationLabel);
    const choices = remoteUploadChoices(
      confirmationLabel,
      active.bundleEntry !== undefined
    );
    const bundleHint =
      active.bundleEntry === undefined
        ? ""
        : ` Choose ${bundleLabel} to resolve static relative requires before sending.`;
    const choice = await vscode.window.showWarningMessage(
      `Create remote script “${name}” from ${active.sourceLabel} (${active.content.length.toLocaleString()} characters)?${bundleHint}`,
      { modal: true },
      ...choices
    );
    if (choice === undefined) {
      return false;
    }

    let upload: UploadContent = active;
    if (choice === bundleLabel && active.bundleEntry !== undefined) {
      const bundled = await this.bundleForUpload(
        active.bundleEntry,
        active.sourceLabel
      );
      if (bundled === undefined) {
        return false;
      }
      upload = bundled;
    } else if (choice !== confirmationLabel) {
      return false;
    }

    return this.postScript(api, name, upload.content, upload.sourceLabel);
  }

  private async bundleForUpload(
    entry: BundleEntry,
    sourceLabel: string
  ): Promise<UploadContent | undefined> {
    const host = new VscodeFileHost(entry.workspaceRoot);
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Bundling ${sourceLabel}…`,
          cancellable: false
        },
        () =>
          compileBundle(entry.entryPath, host, {
            darkluaPath: resolveDarkluaPath(
              this.context.extensionPath,
              vscode.workspace
                .getConfiguration(DARKLUA_CONFIGURATION_SECTION)
                .get<string>("path", "")
            )
          })
      );
      return {
        content: result.code,
        sourceLabel: path.basename(makeOutputPath(entry.entryPath))
      };
    } catch (error) {
      const message =
        error instanceof BundleError
          ? error.message
          : `Luau bundling failed: ${errorMessage(error)}`;
      await vscode.window.showErrorMessage(message);
      return undefined;
    }
  }

  private async uploadContentToScript(
    api: RemoteApi,
    script: RemoteScriptSummary,
    content: string,
    sourceLabel: string,
    confirmationLabel: RemoteUploadVerb
  ): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Replace remote script “${script.name}” with ${sourceLabel} (${content.length.toLocaleString()} characters)?`,
      { modal: true },
      confirmationLabel
    );
    if (choice !== confirmationLabel) {
      return false;
    }

    return this.putContent(api, script, content, sourceLabel);
  }

  private async createScriptFromContent(
    api: RemoteApi,
    content: string,
    sourceLabel: string
  ): Promise<boolean> {
    const name = await this.promptForScriptName(sourceLabel);
    if (name === undefined) {
      return false;
    }

    const choice = await vscode.window.showWarningMessage(
      `Create remote script “${name}” from ${sourceLabel} (${content.length.toLocaleString()} characters)?`,
      { modal: true },
      "Create"
    );
    if (choice !== "Create") {
      return false;
    }

    return this.postScript(api, name, content, sourceLabel);
  }

  private async promptForScriptName(
    sourceLabel: string
  ): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: "Create remote script",
      prompt: "Enter a name for the new script",
      value: suggestedScriptName(sourceLabel),
      ignoreFocusOut: true,
      validateInput: (input) =>
        input.trim().length === 0 ? "A script name is required." : undefined
    });
    return value?.trim();
  }

  private async postScript(
    api: RemoteApi,
    name: string,
    content: string,
    sourceLabel: string
  ): Promise<boolean> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating “${name}”…`,
        cancellable: false
      },
      () => api.createScript(name, content)
    );
    this.stateEmitter.fire();
    await vscode.window.showInformationMessage(
      `Created “${name}” from ${sourceLabel}.`
    );
    return true;
  }

  private async putContent(
    api: RemoteApi,
    script: RemoteScriptSummary,
    content: string,
    sourceLabel: string
  ): Promise<boolean> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Uploading “${script.name}”…`,
        cancellable: false
      },
      () => api.putScriptContent(script.uuid, content)
    );
    this.stateEmitter.fire();
    await vscode.window.showInformationMessage(
      `Uploaded ${sourceLabel} to “${script.name}”.`
    );
    return true;
  }

  private async pickScript(api: RemoteApi): Promise<RemoteScriptSummary | undefined> {
    const userUuid = await this.ensureUserUuid();
    const scripts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Loading remote scripts…",
        cancellable: false
      },
      () => api.listScripts(userUuid)
    );

    if (scripts.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        `No scripts were found for user ${userUuid}.`,
        "Change User UUID"
      );
      if (choice === "Change User UUID") {
        const changed = await this.promptAndRememberUserUuid();
        if (changed !== undefined) {
          return this.pickScript(api);
        }
      }
      return undefined;
    }

    const items: ScriptQuickPickItem[] = [...scripts]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((script) => ({
        label: script.name.length === 0 ? "(unnamed script)" : script.name,
        description: script.uuid,
        detail: `${script.published_at === null ? "Draft" : "Published"} • Updated ${formatTimestamp(script.updated_at)}`,
        script
      }));

    const selected = await vscode.window.showQuickPick(items, {
      title: "Select a remote script",
      placeHolder: "Search by script name or UUID",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });
    return selected?.script;
  }

  private async pickUploadTarget(
    api: RemoteApi
  ): Promise<UploadTarget | undefined> {
    const userUuid = await this.ensureUserUuid();
    const scripts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Loading remote scripts…",
        cancellable: false
      },
      () => api.listScripts(userUuid)
    );

    const items: UploadTargetQuickPickItem[] = [
      {
        label: "$(add) Create New Script…",
        description: "Upload as a new remote script",
        alwaysShow: true,
        target: { kind: "create" }
      },
      ...[...scripts]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .map((script) => ({
          label: script.name.length === 0 ? "(unnamed script)" : script.name,
          description: script.uuid,
          detail: `${script.published_at === null ? "Draft" : "Published"} • Updated ${formatTimestamp(script.updated_at)}`,
          target: { kind: "existing" as const, script }
        }))
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: "Create a script or select one to overwrite",
      placeHolder: "Create new or search by script name or UUID",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });
    return selected?.target;
  }

  private loadBattleSettings(): BattleSettingsState {
    return normalizeBattleSettings(
      this.context.globalState.get<unknown>(BATTLE_SETTINGS_STATE_KEY)
    );
  }

  private async saveBattleSettings(state: BattleSettingsState): Promise<void> {
    await this.context.globalState.update(BATTLE_SETTINGS_STATE_KEY, state);
  }

  private async configureBattleSettings(): Promise<void> {
    let state = this.loadBattleSettings();

    while (true) {
      const items: BattleSettingsQuickPickItem[] = BATTLE_SETTING_GROUPS.map(
        (group) => {
          const settings = BATTLE_SETTINGS.filter(
            (setting) => setting.group === group.id
          );
          const changed = settings.filter(
            (setting) => battleSettingValue(state, setting) !== setting.defaultValue
          ).length;
          return {
            label: group.label,
            description: changed === 0 ? "defaults" : `${changed} changed`,
            action: { kind: "group", group: group.id }
          };
        }
      );

      items.push({
        label: "Disallowed brawler IDs",
        description:
          state.disabledBrawlerIds.length === 0
            ? "none"
            : `${state.disabledBrawlerIds.length} blocked`,
        detail: "Advanced: comma-separated numeric brawler IDs.",
        action: { kind: "brawlers" }
      });

      if (battleSettingsChangeCount(state) > 0) {
        items.push({
          label: "$(discard) Reset all battle settings",
          description: `${battleSettingsChangeCount(state)} changed`,
          action: { kind: "reset" }
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        title: "Battle Settings",
        placeHolder: "Choose a compact settings group to edit",
        ignoreFocusOut: true
      });
      if (selected === undefined) {
        return;
      }

      if (selected.action.kind === "reset") {
        state = defaultBattleSettings();
        await this.saveBattleSettings(state);
        continue;
      }

      if (selected.action.kind === "brawlers") {
        const updated = await this.editDisabledBrawlerIds(state);
        if (updated !== state) {
          state = updated;
          await this.saveBattleSettings(state);
        }
        continue;
      }

      state = await this.configureBattleSettingsGroup(
        state,
        selected.action.group
      );
    }
  }

  private async configureBattleSettingsGroup(
    initialState: BattleSettingsState,
    group: BattleSettingGroupId
  ): Promise<BattleSettingsState> {
    let state = initialState;
    const groupLabel =
      BATTLE_SETTING_GROUPS.find((candidate) => candidate.id === group)?.label ??
      "Battle Settings";

    while (true) {
      const items: BattleSettingQuickPickItem[] = [
        { label: "$(arrow-left) Back" },
        ...BATTLE_SETTINGS.filter((setting) => setting.group === group).map(
          (setting) => ({
            label: setting.label,
            description: formatBattleSettingValue(state, setting),
            detail:
              setting.description ??
              (setting.kind === "number"
                ? `Range ${setting.min} to ${setting.max}; default ${setting.defaultValue}${setting.suffix ?? ""}.`
                : `Default: ${setting.defaultValue === setting.trueValue ? "Enabled" : "Disabled"}.`),
            setting
          })
        )
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: `Battle Settings · ${groupLabel}`,
        placeHolder: "Choose a setting",
        ignoreFocusOut: true
      });
      if (selected?.setting === undefined) {
        return state;
      }

      const updated = await this.editBattleSetting(state, selected.setting);
      if (updated !== state) {
        state = updated;
        await this.saveBattleSettings(state);
      }
    }
  }

  private async editBattleSetting(
    state: BattleSettingsState,
    setting: BattleSetting
  ): Promise<BattleSettingsState> {
    const current = battleSettingValue(state, setting);
    if (setting.kind === "boolean") {
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: "Enabled",
            description: current === setting.trueValue ? "current" : undefined,
            value: setting.trueValue
          },
          {
            label: "Disabled",
            description: current === setting.falseValue ? "current" : undefined,
            value: setting.falseValue
          }
        ],
        {
          title: setting.label,
          placeHolder: "Choose a value",
          ignoreFocusOut: true
        }
      );
      return selected === undefined
        ? state
        : updateBattleSetting(state, setting, selected.value);
    }

    const entered = await vscode.window.showInputBox({
      title: setting.label,
      prompt: `Enter an integer from ${setting.min} to ${setting.max}`,
      value: String(current),
      ignoreFocusOut: true,
      validateInput: (value) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) {
          return "Enter an integer.";
        }
        if (parsed < setting.min || parsed > setting.max) {
          return `Enter a value from ${setting.min} to ${setting.max}.`;
        }
        return undefined;
      }
    });
    if (entered === undefined) {
      return state;
    }
    return updateBattleSetting(state, setting, Number(entered));
  }

  private async editDisabledBrawlerIds(
    state: BattleSettingsState
  ): Promise<BattleSettingsState> {
    const entered = await vscode.window.showInputBox({
      title: "Disallowed brawler IDs",
      prompt: "Enter comma-separated numeric IDs, or leave empty to allow all",
      value: state.disabledBrawlerIds.join(", "),
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value.trim().length === 0) {
          return undefined;
        }
        return parseBrawlerIds(value) === undefined
          ? "Use positive integer IDs separated by commas."
          : undefined;
      }
    });
    if (entered === undefined) {
      return state;
    }
    return updateDisabledBrawlerIds(state, parseBrawlerIds(entered) ?? []);
  }

  private async ensureUserUuid(): Promise<string> {
    const stored = this.context.globalState.get<string>(USER_UUID_STATE_KEY);
    if (stored !== undefined && UUID_PATTERN.test(stored)) {
      return stored;
    }

    const entered = await this.promptAndRememberUserUuid();
    if (entered === undefined) {
      throw new RemoteOperationCancelledError();
    }
    return entered;
  }

  private async promptAndRememberUserUuid(): Promise<string | undefined> {
    const current = this.context.globalState.get<string>(USER_UUID_STATE_KEY) ?? "";
    const value = await vscode.window.showInputBox({
      title: "Scripting API user",
      prompt: "Enter the user UUID whose scripts should be listed",
      value: current,
      ignoreFocusOut: true,
      validateInput: (input) =>
        UUID_PATTERN.test(input.trim()) ? undefined : "Enter a valid UUID."
    });
    if (value === undefined) {
      return undefined;
    }

    const uuid = value.trim();
    await this.context.globalState.update(USER_UUID_STATE_KEY, uuid);
    this.stateEmitter.fire();
    return uuid;
  }

  private async promptForCredentials(
    savedUsername: string | undefined
  ): Promise<RemoteCredentials | undefined> {
    const username = await vscode.window.showInputBox({
      title: "Sign in to the scripting API",
      prompt: "Username",
      value: savedUsername ?? "",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "Username is required." : undefined
    });
    if (username === undefined) {
      return undefined;
    }

    const password = await vscode.window.showInputBox({
      title: "Sign in to the scripting API",
      prompt: "Password (stored in VS Code Secret Storage after a successful login)",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.length === 0 ? "Password is required." : undefined
    });
    if (password === undefined) {
      return undefined;
    }

    return { username: username.trim(), password };
  }

  private async copyDeeplink(
    deeplink: string,
    message: string,
    error = false
  ): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(deeplink);
    } catch (clipboardError) {
      await vscode.window.showErrorMessage(
        `Could not copy the deeplink to the clipboard: ${errorMessage(clipboardError)}`
      );
      return;
    }

    if (error) {
      await vscode.window.showErrorMessage(message);
    } else {
      await vscode.window.showInformationMessage(message);
    }
  }

  private createApi(): RemoteApi {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    return new RemoteApi({
      store: this.store,
      promptForCredentials: (savedUsername) =>
        this.promptForCredentials(savedUsername),
      baseUrl: configuration.get<string>("baseUrl", DEFAULT_REMOTE_BASE_URL),
      loginPath: configuration.get<string>("loginPath", DEFAULT_LOGIN_PATH),
      cookieName: configuration.get<string>("cookieName", DEFAULT_COOKIE_NAME)
    });
  }

  private async rememberLoginUser(result: LoginResult): Promise<void> {
    if (result.userUuid !== undefined && UUID_PATTERN.test(result.userUuid)) {
      await this.context.globalState.update(USER_UUID_STATE_KEY, result.userUuid);
    }
  }

  private async runRemote<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RemoteOperationCancelledError) {
        return undefined;
      }

      const message =
        error instanceof RemoteApiError
          ? error.message
          : `Remote scripting operation failed: ${errorMessage(error)}`;
      const signInSuggested =
        error instanceof RemoteApiError &&
        (error.status === 400 || error.status === 401 || error.status === 403);
      const choice = signInSuggested
        ? await vscode.window.showErrorMessage(message, "Sign In Again")
        : await vscode.window.showErrorMessage(message);

      if (choice === "Sign In Again") {
        await vscode.commands.executeCommand(REMOTE_LOGIN_COMMAND);
      }
      return undefined;
    }
  }
}

class VscodeRemoteStore implements RemoteStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async loadCredentials(): Promise<RemoteCredentials | undefined> {
    const value = await this.secrets.get(CREDENTIALS_SECRET_KEY);
    if (value === undefined) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.username === "string" &&
        typeof parsed.password === "string"
      ) {
        return { username: parsed.username, password: parsed.password };
      }
    } catch {
      // Treat damaged secret state as signed out.
    }

    await this.secrets.delete(CREDENTIALS_SECRET_KEY);
    return undefined;
  }

  async saveCredentials(credentials: RemoteCredentials): Promise<void> {
    await this.secrets.store(CREDENTIALS_SECRET_KEY, JSON.stringify(credentials));
  }

  async clearCredentials(): Promise<void> {
    await this.secrets.delete(CREDENTIALS_SECRET_KEY);
  }

  async loadSession(): Promise<StoredRemoteSession | undefined> {
    const value = await this.secrets.get(SESSION_SECRET_KEY);
    if (value === undefined) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.baseUrl === "string" &&
        typeof parsed.cookie === "string"
      ) {
        return { baseUrl: parsed.baseUrl, cookie: parsed.cookie };
      }
    } catch {
      // Treat damaged secret state as an expired session.
    }

    await this.secrets.delete(SESSION_SECRET_KEY);
    return undefined;
  }

  async saveSession(session: StoredRemoteSession): Promise<void> {
    await this.secrets.store(SESSION_SECRET_KEY, JSON.stringify(session));
  }

  async clearSession(): Promise<void> {
    await this.secrets.delete(SESSION_SECRET_KEY);
  }
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? value : timestamp.toLocaleString();
}

function suggestedScriptName(sourceLabel: string): string {
  if (sourceLabel === "the active unsaved editor") {
    return "";
  }
  return sourceLabel
    .replace(/\.bundle\.luau$/i, "")
    .replace(/\.(?:lua|luau)$/i, "");
}

function parseBrawlerIds(value: string): readonly number[] | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const ids = trimmed.split(",").map((item) => Number(item.trim()));
  return ids.every((id) => Number.isSafeInteger(id) && id > 0)
    ? ids
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
