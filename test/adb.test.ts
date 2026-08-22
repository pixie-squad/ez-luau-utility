import assert from "node:assert/strict";
import test from "node:test";

import {
  AdbLaunchError,
  openDeeplinkWithAdb,
  parseAuthorizedAdbDevices,
  type AdbExecutor
} from "../src/adb";

const DEEPLINK =
  "nullsbrawl://createAndJoinRoom?roomname=params:v2:abc&friendly=1&side=0";

test("parses only authorized ADB devices", () => {
  assert.deepEqual(
    parseAuthorizedAdbDevices(
      [
        "List of devices attached",
        "emulator-5554\tdevice product:sdk model:Pixel",
        "192.0.2.1:5555\tunauthorized",
        "offline-device\toffline",
        ""
      ].join("\r\n")
    ),
    ["emulator-5554"]
  );
});

test("opens the deeplink on the first authorized ADB device", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const execute: AdbExecutor = async (executable, args) => {
    calls.push({ executable, args });
    return calls.length === 1
      ? {
          stdout:
            "List of devices attached\nphone-1\tdevice\nphone-2\tdevice\n",
          stderr: ""
        }
      : { stdout: "Starting: Intent { act=android.intent.action.VIEW }", stderr: "" };
  };

  const result = await openDeeplinkWithAdb(DEEPLINK, {
    adbPath: "C:\\Android\\adb.exe",
    execute
  });

  assert.deepEqual(result, { kind: "launched", serial: "phone-1" });
  assert.deepEqual(calls[0], {
    executable: "C:\\Android\\adb.exe",
    args: ["devices"]
  });
  assert.deepEqual(calls[1], {
    executable: "C:\\Android\\adb.exe",
    args: [
      "-s",
      "phone-1",
      "shell",
      `am start -W -a android.intent.action.VIEW -d '${DEEPLINK}'`
    ]
  });
});

test("returns a clipboard-fallback result when ADB or a device is unavailable", async (t) => {
  await t.test("ADB unavailable", async () => {
    const result = await openDeeplinkWithAdb(DEEPLINK, {
      execute: async () => {
        throw new Error("spawn adb ENOENT");
      }
    });
    assert.deepEqual(result, {
      kind: "not-connected",
      reason: "adb-unavailable"
    });
  });

  await t.test("no authorized device", async () => {
    const result = await openDeeplinkWithAdb(DEEPLINK, {
      execute: async () => ({
        stdout: "List of devices attached\nphone\tunauthorized\n",
        stderr: ""
      })
    });
    assert.deepEqual(result, {
      kind: "not-connected",
      reason: "no-authorized-device"
    });
  });

  await t.test("device disconnects before launch", async () => {
    let call = 0;
    const result = await openDeeplinkWithAdb(DEEPLINK, {
      execute: async () => {
        call += 1;
        if (call === 1) {
          return {
            stdout: "List of devices attached\nphone\tdevice\n",
            stderr: ""
          };
        }
        const error = new Error("Command failed") as Error & { stderr: string };
        error.stderr = "error: device offline";
        throw error;
      }
    });
    assert.deepEqual(result, {
      kind: "not-connected",
      reason: "device-disconnected"
    });
  });
});

test("reports an Android launch failure without exposing the bearer deeplink", async () => {
  let call = 0;
  await assert.rejects(
    openDeeplinkWithAdb(DEEPLINK, {
      execute: async () => {
        call += 1;
        return call === 1
          ? {
              stdout: "List of devices attached\nphone\tdevice\n",
              stderr: ""
            }
          : {
              stdout: `Error: Activity not started for ${DEEPLINK}`,
              stderr: ""
            };
      }
    }),
    (error: unknown) =>
      error instanceof AdbLaunchError &&
      !error.message.includes("nullsbrawl://")
  );
});
