import path from "node:path";

const BUNDLED_DARKLUA_PATHS: Readonly<Record<string, string>> = {
  "win32-x64": "bin/darklua/win32-x64/darklua.exe",
  "linux-x64": "bin/darklua/linux-x64/darklua",
  "linux-arm64": "bin/darklua/linux-arm64/darklua",
  "darwin-x64": "bin/darklua/darwin-x64/darklua",
  "darwin-arm64": "bin/darklua/darwin-arm64/darklua"
};

export function resolveDarkluaPath(
  extensionRoot: string,
  configuredPath: string | undefined,
  platform: string = process.platform,
  architecture: string = process.arch
): string {
  const override = configuredPath?.trim();
  if (override) {
    return override;
  }

  const relativePath = BUNDLED_DARKLUA_PATHS[`${platform}-${architecture}`];
  if (relativePath === undefined) {
    throw new Error(
      `No bundled darklua executable is available for ${platform}-${architecture}. Configure ezLuauUtility.darklua.path to use an external executable.`
    );
  }
  return path.join(extensionRoot, ...relativePath.split("/"));
}
