import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLE_SETTINGS,
  createBattleSettingsPayload,
  defaultBattleSettings,
  normalizeBattleSettings,
  updateBattleSetting,
  updateDisabledBrawlerIds
} from "../src/battleSettings";

test("emits the documented default battle parameter order", () => {
  assert.deepEqual(createBattleSettingsPayload(defaultBattleSettings()), {
    bp: [
      0, 0, 0, 0, 0, 0, 100, 0,
      0, 0, 0, 0, 13, 0, 4, 0,
      1, 1, 1, 2, 1, 0, 0, -1,
      100, 0, 0, 0, 1, 1, 1, 20
    ],
    bc: []
  });
});

test("converts displayed delta values to in-game battle parameters", () => {
  const speed = requiredSetting("buffSpeed");
  const respawnShield = requiredSetting("valueRespawnShield");
  let state = defaultBattleSettings();
  state = updateBattleSetting(state, speed, 140);
  state = updateBattleSetting(state, respawnShield, 8);
  state = updateDisabledBrawlerIds(state, [16000000, 16000001, 16000000]);

  const payload = createBattleSettingsPayload(state);
  assert.equal(payload.bp[4], 40);
  assert.equal(payload.bp[15], 5);
  assert.deepEqual(payload.bc, [16000000, 16000001]);
});

test("drops invalid persisted values and preserves valid overrides", () => {
  assert.deepEqual(
    normalizeBattleSettings({
      values: {
        abilityGears: 1,
        buffSpeed: 999,
        missing: 10
      },
      disabledBrawlerIds: [4, -1, 2, 4, "3"]
    }),
    {
      values: { abilityGears: 1 },
      disabledBrawlerIds: [2, 4]
    }
  );
});

function requiredSetting(id: string) {
  const setting = BATTLE_SETTINGS.find((candidate) => candidate.id === id);
  assert.ok(setting);
  return setting;
}
