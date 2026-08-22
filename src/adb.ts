import { execFile } from "node:child_process";

const ADB_TIMEOUT_MS = 20_000;
const ADB_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface AdbCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type AdbExecutor = (
  executable: string,
  args: readonly string[]
) => Promise<AdbCommandOutput>;

export type AdbDeeplinkResult =
  | { readonly kind: "launched"; readonly serial: string }
  | {
      readonly kind: "not-connected";
      readonly reason: "adb-unavailable" | "no-authorized-device" | "device-disconnected";
    };

export interface OpenDeeplinkWithAdbOptions {
  readonly adbPath?: string;
  readonly execute?: AdbExecutor;
}

export class AdbLaunchError extends Error {
  constructor(serial: string, options?: { readonly cause?: unknown }) {
    super(
      `ADB found device ${serial}, but Android could not open the application deeplink.`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "AdbLaunchError";
  }
}

export async function openDeeplinkWithAdb(
  deeplink: string,
  options: OpenDeeplinkWithAdbOptions = {}
): Promise<AdbDeeplinkResult> {
  const adbPath = options.adbPath?.trim() || "adb";
  const execute = options.execute ?? executeAdb;

  let deviceOutput: AdbCommandOutput;
  try {
    deviceOutput = await execute(adbPath, ["devices"]);
  } catch {
    return { kind: "not-connected", reason: "adb-unavailable" };
  }

  const serial = parseAuthorizedAdbDevices(deviceOutput.stdout)[0];
  if (serial === undefined) {
    return { kind: "not-connected", reason: "no-authorized-device" };
  }

  const command =
    "am start -W -a android.intent.action.VIEW -d " +
    quoteRemoteShellArgument(deeplink);

  try {
    const output = await execute(adbPath, ["-s", serial, "shell", command]);
    if (isActivityManagerFailure(`${output.stdout}\n${output.stderr}`)) {
      throw new AdbLaunchError(serial);
    }
  } catch (error) {
    if (error instanceof AdbLaunchError) {
      throw error;
    }
    if (isDisconnectedError(error)) {
      return { kind: "not-connected", reason: "device-disconnected" };
    }
    throw new AdbLaunchError(serial, { cause: error });
  }

  return { kind: "launched", serial };
}

export function parseAuthorizedAdbDevices(output: string): readonly string[] {
  const devices: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+device(?:\s|$)/.exec(line.trim());
    if (match?.[1] !== undefined) {
      devices.push(match[1]);
    }
  }
  return devices;
}

function executeAdb(
  executable: string,
  args: readonly string[]
): Promise<AdbCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: ADB_TIMEOUT_MS,
        maxBuffer: ADB_MAX_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = new Error(error.message, { cause: error }) as Error & {
            stdout?: string;
            stderr?: string;
          };
          failure.stdout = String(stdout);
          failure.stderr = String(stderr);
          reject(failure);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function quoteRemoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isActivityManagerFailure(output: string): boolean {
  return /(?:^|\n)\s*(?:error:|exception occurred)|unable to resolve intent|error type \d+/i.test(
    output
  );
}

function isDisconnectedError(error: unknown): boolean {
  const output = failureOutput(error);
  return /device .* not found|device offline|device unauthorized|no devices\/emulators found|transport (?:error|is closing)|connection (?:reset|closed)/i.test(
    output
  );
}

function failureOutput(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  if (typeof error === "object" && error !== null) {
    if ("stdout" in error && typeof error.stdout === "string") {
      parts.push(error.stdout);
    }
    if ("stderr" in error && typeof error.stderr === "string") {
      parts.push(error.stderr);
    }
  }
  return parts.join("\n");
}
