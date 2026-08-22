import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface CommandContribution {
  readonly command: string;
}

interface MenuContribution {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

interface ViewContribution {
  readonly id: string;
  readonly name: string;
}

interface ExtensionManifest {
  readonly name: string;
  readonly displayName: string;
  readonly activationEvents: readonly string[];
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly viewsContainers: {
      readonly activitybar: ReadonlyArray<{
        readonly id: string;
        readonly icon: string;
      }>;
    };
    readonly views: Record<string, readonly ViewContribution[]>;
    readonly menus: Record<string, readonly MenuContribution[]>;
  };
}

const CONTAINER_ID = "ezLuauUtility";
const AUTH_VIEW_ID = "ezLuauUtility.remoteAuth";
const SCRIPTS_VIEW_ID = "ezLuauUtility.remoteScripts";
const REFRESH_COMMAND = "ezLuauUtility.remoteRefreshScripts";
const UPLOAD_COMMAND = "ezLuauUtility.remoteUploadActiveFile";
const OPEN_COMMAND = "ezLuauUtility.remoteOpenScript";
const START_BATTLE_COMMAND = "ezLuauUtility.remoteStartBattle";
const OVERWRITE_COMMAND = "ezLuauUtility.remoteOverwriteScript";

test("contributes the ez-luau-utility sidebar and its required actions", async () => {
  const manifest = JSON.parse(
    await readFile(path.resolve("package.json"), "utf-8")
  ) as ExtensionManifest;

  assert.equal(manifest.name, "ez-luau-utility");
  assert.equal(manifest.displayName, "ez-luau-utility");

  const container = manifest.contributes.viewsContainers.activitybar.find(
    (item) => item.id === CONTAINER_ID
  );
  assert.ok(container);
  assert.equal(
    (await stat(path.resolve(container.icon))).isFile(),
    true,
    "the Activity Bar icon must be packaged from a real file"
  );

  assert.deepEqual(
    manifest.contributes.views[CONTAINER_ID],
    [
      { id: AUTH_VIEW_ID, name: "Authentication" },
      { id: SCRIPTS_VIEW_ID, name: "Script Explorer" }
    ]
  );

  const commandIds = new Set(
    manifest.contributes.commands.map((command) => command.command)
  );
  for (const command of [
    REFRESH_COMMAND,
    UPLOAD_COMMAND,
    OPEN_COMMAND,
    START_BATTLE_COMMAND,
    OVERWRITE_COMMAND
  ]) {
    assert.equal(commandIds.has(command), true, `${command} must be contributed`);
  }

  const titleCommands = manifest.contributes.menus["view/title"] ?? [];
  assert.equal(
    titleCommands.some(
      (item) => item.command === REFRESH_COMMAND && item.when?.includes(SCRIPTS_VIEW_ID)
    ),
    true
  );
  assert.equal(
    titleCommands.some(
      (item) => item.command === UPLOAD_COMMAND && item.when?.includes(SCRIPTS_VIEW_ID)
    ),
    true
  );
  assert.equal(
    titleCommands.some(
      (item) =>
        item.command === START_BATTLE_COMMAND &&
        item.when?.includes(SCRIPTS_VIEW_ID) &&
        item.group?.startsWith("navigation")
    ),
    true
  );

  const itemCommands = manifest.contributes.menus["view/item/context"] ?? [];
  assert.equal(
    itemCommands.some(
      (item) =>
        item.command === START_BATTLE_COMMAND &&
        item.when?.includes("viewItem == remoteScript") &&
        item.group?.startsWith("inline")
    ),
    true
  );
  assert.equal(
    itemCommands.some(
      (item) =>
        item.command === OVERWRITE_COMMAND &&
        item.when?.includes("viewItem == remoteScript") &&
        item.group?.startsWith("inline")
    ),
    true
  );

  for (const view of [AUTH_VIEW_ID, SCRIPTS_VIEW_ID]) {
    assert.equal(manifest.activationEvents.includes(`onView:${view}`), true);
  }
  assert.equal(
    manifest.activationEvents.includes(`onCommand:${START_BATTLE_COMMAND}`),
    true
  );
});
