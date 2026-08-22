import { hasGeneratedMarker } from "./output";

export type OutputConflict = "dirty-buffer" | "unowned-file";
export type RemoteUploadVerb = "Create" | "Upload" | "Overwrite";

export function outputConflict(input: {
  readonly exists: boolean;
  readonly isDirty: boolean;
  readonly contents?: string;
}): OutputConflict | undefined {
  if (input.isDirty) {
    return "dirty-buffer";
  }

  if (input.exists && !hasGeneratedMarker(input.contents ?? "")) {
    return "unowned-file";
  }

  return undefined;
}

export async function preferBufferedText(
  bufferedText: string | undefined,
  readDiskText: () => Promise<string>
): Promise<string> {
  return bufferedText ?? readDiskText();
}

export function bundleUploadLabel(verb: RemoteUploadVerb): string {
  return `Bundle & ${verb}`;
}

export function remoteUploadChoices(
  verb: RemoteUploadVerb,
  canBundle: boolean
): readonly string[] {
  return canBundle ? [verb, bundleUploadLabel(verb)] : [verb];
}
