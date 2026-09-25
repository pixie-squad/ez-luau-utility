export type BattleSettingGroupId =
  | "levels"
  | "buffs"
  | "automatic"
  | "items"
  | "other"
  | "flags"
  | "abilities";

export interface BattleSettingGroup {
  readonly id: BattleSettingGroupId;
  readonly label: string;
}

interface BattleSettingBase {
  readonly id: string;
  readonly group: BattleSettingGroupId;
  readonly label: string;
  readonly index: number;
  readonly defaultValue: number;
  readonly description?: string;
}

export interface BattleNumberSetting extends BattleSettingBase {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly delta?: boolean;
  readonly suffix?: string;
}

export interface BattleBooleanSetting extends BattleSettingBase {
  readonly kind: "boolean";
  readonly falseValue: number;
  readonly trueValue: number;
}

export type BattleSetting = BattleNumberSetting | BattleBooleanSetting;

export interface BattleSettingsState {
  readonly values: Readonly<Record<string, number>>;
  readonly disabledBrawlerIds: readonly number[];
}

export interface BattleSettingsPayload {
  readonly bp: readonly number[];
  readonly bc: readonly number[];
}

export const BATTLE_SETTING_GROUPS: readonly BattleSettingGroup[] = [
  { id: "levels", label: "Levels" },
  { id: "buffs", label: "Multipliers & Buffs" },
  { id: "automatic", label: "Automatic Charging" },
  { id: "items", label: "Item Drops" },
  { id: "other", label: "Other Values" },
  { id: "flags", label: "Battle Flags" },
  { id: "abilities", label: "Brawler Abilities" }
];

export const BATTLE_SETTINGS: readonly BattleSetting[] = [
  numberSetting("levelHitPoints", "Hit points level", "levels", 0, 11, -8, 100, {
    delta: true
  }),
  numberSetting("levelWeapon", "Attack level", "levels", 1, 11, -8, 100, {
    delta: true
  }),
  numberSetting("levelUlti", "Super level", "levels", 2, 11, -8, 100, {
    delta: true
  }),
  numberSetting("levelServer", "Battle level", "levels", 3, 11, -8, 100, {
    delta: true,
    description: "Used for objects such as Showdown boxes and the Heist safe."
  }),
  numberSetting("buffSpeed", "Movement speed", "buffs", 4, 100, 30, 220, {
    delta: true,
    suffix: "%"
  }),
  numberSetting("buffReload", "Reload speed", "buffs", 5, 100, 10, 500, {
    delta: true,
    suffix: "%"
  }),
  numberSetting(
    "multUltiCharge",
    "Super charge multiplier",
    "buffs",
    6,
    100,
    0,
    500,
    { suffix: "%" }
  ),
  numberSetting("chargeUlti", "Charge super", "automatic", 7, 0, 0, 100, {
    suffix: "%"
  }),
  numberSetting(
    "chargeHyper",
    "Charge hypercharge",
    "automatic",
    8,
    0,
    0,
    100,
    { suffix: "%" }
  ),
  numberSetting(
    "valueGadgetCooldowns",
    "Gadget cooldown",
    "other",
    9,
    100,
    0,
    200,
    { delta: true, suffix: "%" }
  ),
  numberSetting("valueExtPets", "Extra pets", "other", 10, 0, 0, 20),
  numberSetting("valuePoisonDamage", "Poison damage", "other", 11, 20, 0, 100, {
    delta: true,
    suffix: "%"
  }),
  numberSetting("valueRegeneration", "Regeneration", "other", 12, 13, 0, 100, {
    suffix: "%"
  }),
  booleanSetting("flagNoPoison", "Disable poison", "flags", 13, false, 0),
  numberSetting("valueAIDifficulty", "Bot difficulty", "other", 14, 4, -1, 4),
  numberSetting("valueRespawnShield", "Respawn shield", "other", 15, 3, 0, 20, {
    delta: true,
    suffix: "s"
  }),
  booleanSetting("abilityGadgets", "Allow gadgets", "abilities", 16, true, 0),
  booleanSetting(
    "abilityStarPowers",
    "Allow star powers",
    "abilities",
    17,
    true,
    0
  ),
  booleanSetting(
    "abilityOvercharges",
    "Allow hypercharges",
    "abilities",
    18,
    true,
    0
  ),
  numberSetting("abilityGears", "Number of gears", "abilities", 19, 2, 0, 2),
  numberSetting("boxPowerPoints", "Power cubes from boxes", "items", 20, 1, 0, 10),
  booleanSetting(
    "flagNoPoisonProgres",
    "Disable progressive poison damage",
    "flags",
    21,
    false,
    0
  ),
  numberSetting("clientSpawnOffset", "Base player spawn point", "other", 22, 0, 0, 10),
  booleanSetting(
    "flagRestrictTeamJoin",
    "Restrict room joining",
    "flags",
    23,
    false,
    -1
  ),
  numberSetting(
    "characterPowerPointsRate",
    "Power cubes from brawlers",
    "items",
    24,
    100,
    0,
    500,
    { suffix: "%" }
  ),
  booleanSetting(
    "flagSelectionVisible",
    "Show brawler selection",
    "flags",
    25,
    false,
    0
  ),
  booleanSetting("flagAllowExit", "Allow early exit", "flags", 26, false, 0),
  booleanSetting("flagAllowChat", "Show battle chat", "flags", 27, false, 0),
  booleanSetting(
    "abilityGadgetsBuddy",
    "Allow gadget buffs",
    "abilities",
    28,
    true,
    0
  ),
  booleanSetting(
    "abilityStarPowersBuddy",
    "Allow star-power buffs",
    "abilities",
    29,
    true,
    0
  ),
  booleanSetting(
    "abilityOverchargesBuddy",
    "Allow hypercharge buffs",
    "abilities",
    30,
    true,
    0
  ),
  numberSetting("automationTicks", "Charge periodicity", "automatic", 31, 20, 1, 100, {
    suffix: " ticks",
    description: "20 ticks equals one second."
  })
];

const SETTINGS_BY_ID = new Map(BATTLE_SETTINGS.map((setting) => [setting.id, setting]));

export function defaultBattleSettings(): BattleSettingsState {
  return { values: {}, disabledBrawlerIds: [] };
}

export function normalizeBattleSettings(value: unknown): BattleSettingsState {
  if (!isRecord(value)) {
    return defaultBattleSettings();
  }

  const values: Record<string, number> = {};
  if (isRecord(value.values)) {
    for (const [id, storedValue] of Object.entries(value.values)) {
      const setting = SETTINGS_BY_ID.get(id);
      if (
        setting !== undefined &&
        typeof storedValue === "number" &&
        Number.isFinite(storedValue) &&
        isAllowedValue(setting, storedValue)
      ) {
        values[id] = storedValue;
      }
    }
  }

  const disabledBrawlerIds = Array.isArray(value.disabledBrawlerIds)
    ? [...new Set(value.disabledBrawlerIds.filter(isBrawlerId))].sort(
        (left, right) => left - right
      )
    : [];

  return { values, disabledBrawlerIds };
}

export function createBattleSettingsPayload(
  state: BattleSettingsState
): BattleSettingsPayload {
  const bp = Array<number>(BATTLE_SETTINGS.length).fill(0);
  for (const setting of BATTLE_SETTINGS) {
    const value = battleSettingValue(state, setting);
    bp[setting.index] =
      setting.kind === "number" && setting.delta
        ? value - setting.defaultValue
        : value;
  }
  return { bp, bc: [...state.disabledBrawlerIds] };
}

export function battleSettingValue(
  state: BattleSettingsState,
  setting: BattleSetting
): number {
  return state.values[setting.id] ?? setting.defaultValue;
}

export function updateBattleSetting(
  state: BattleSettingsState,
  setting: BattleSetting,
  value: number
): BattleSettingsState {
  if (!isAllowedValue(setting, value)) {
    return state;
  }

  const values = { ...state.values };
  if (value === setting.defaultValue) {
    delete values[setting.id];
  } else {
    values[setting.id] = value;
  }
  return { ...state, values };
}

export function updateDisabledBrawlerIds(
  state: BattleSettingsState,
  ids: readonly number[]
): BattleSettingsState {
  return {
    ...state,
    disabledBrawlerIds: [...new Set(ids.filter(isBrawlerId))].sort(
      (left, right) => left - right
    )
  };
}

export function formatBattleSettingValue(
  state: BattleSettingsState,
  setting: BattleSetting
): string {
  const value = battleSettingValue(state, setting);
  if (setting.kind === "boolean") {
    return value === setting.trueValue ? "Enabled" : "Disabled";
  }
  return `${value}${setting.suffix ?? ""}`;
}

export function battleSettingsChangeCount(state: BattleSettingsState): number {
  return Object.keys(state.values).length + (state.disabledBrawlerIds.length > 0 ? 1 : 0);
}

function numberSetting(
  id: string,
  label: string,
  group: BattleSettingGroupId,
  index: number,
  defaultValue: number,
  min: number,
  max: number,
  options: {
    readonly delta?: boolean;
    readonly suffix?: string;
    readonly description?: string;
  } = {}
): BattleNumberSetting {
  return {
    kind: "number",
    id,
    label,
    group,
    index,
    defaultValue,
    min,
    max,
    ...options
  };
}

function booleanSetting(
  id: string,
  label: string,
  group: BattleSettingGroupId,
  index: number,
  defaultEnabled: boolean,
  falseValue: number
): BattleBooleanSetting {
  return {
    kind: "boolean",
    id,
    label,
    group,
    index,
    defaultValue: defaultEnabled ? 1 : falseValue,
    falseValue,
    trueValue: 1
  };
}

function isAllowedValue(setting: BattleSetting, value: number): boolean {
  if (setting.kind === "boolean") {
    return value === setting.falseValue || value === setting.trueValue;
  }
  return value >= setting.min && value <= setting.max;
}

function isBrawlerId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
