import assert from "node:assert/strict";
import test from "node:test";

import { createScriptingDeeplink, encodeBase62 } from "../src/deeplink";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SCRIPT_UUID = "01a01a56-bef2-7a0a-b5a2-f724617b194c";
const DOCUMENTED_PREFIX =
  "5UEPHKfjnZmD1hYX2wpBRAuRXW5IqAhnu3sWoY2QDa7EnvgucTnf3agdJnjE";

test("constructs the documented NT Scripting deeplink", () => {
  const deeplink = createScriptingDeeplink(
    SCRIPT_UUID,
    "test",
    "https://scripting.donutquine.dev"
  );
  const payload = extractPayload(deeplink);

  assert.equal(payload.startsWith(DOCUMENTED_PREFIX), true);
  assert.equal(
    deeplink,
    `nullsbrawl://createAndJoinRoom?roomname=params:v2:${payload}&friendly=1&side=0`
  );
  assert.deepEqual(JSON.parse(decodeBase62(payload)), {
    realm: "experiment:scripts",
    script:
      `https://scripting.donutquine.dev/api/scripts/${SCRIPT_UUID}/content?token=test`,
    bp: [
      0, 0, 0, 0, 0, 0, 100, 0,
      0, 0, 0, 0, 13, 0, 4, 0,
      1, 1, 1, 2, 1, 0, 0, -1,
      100, 0, 0, 1, 1, 1, 1, 20
    ]
  });
});

test("encodes the share token and honors a configured remote base URL", () => {
  const payload = extractPayload(
    createScriptingDeeplink(
      SCRIPT_UUID,
      "a/b? c&=",
      "https://example.test/scripting/"
    )
  );
  const config = JSON.parse(decodeBase62(payload)) as { readonly script: string };

  assert.equal(
    config.script,
    `https://example.test/scripting/api/scripts/${SCRIPT_UUID}/content?token=a%2Fb%3F%20c%26%3D`
  );
});

test("base62 encoding preserves base-x leading zero behavior", () => {
  assert.equal(encodeBase62(new Uint8Array()), "");
  assert.equal(encodeBase62(Uint8Array.of(0)), "0");
  assert.equal(encodeBase62(Uint8Array.of(0, 0, 1)), "001");
  assert.equal(encodeBase62(Uint8Array.of(255)), "47");
});

function extractPayload(deeplink: string): string {
  const match = /roomname=params:v2:([^&]+)&friendly=1&side=0$/.exec(deeplink);
  assert.ok(match?.[1]);
  return match[1];
}

function decodeBase62(payload: string): string {
  let value = 0n;
  for (const character of payload) {
    const digit = BASE62_ALPHABET.indexOf(character);
    assert.notEqual(digit, -1);
    value = value * 62n + BigInt(digit);
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex").toString("utf8");
}
