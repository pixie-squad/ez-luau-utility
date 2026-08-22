import assert from "node:assert/strict";
import test from "node:test";

import { GENERATED_MARKER } from "../src/output";
import {
  bundleUploadLabel,
  outputConflict,
  preferBufferedText,
  remoteUploadChoices
} from "../src/policies";

test("prefers unsaved buffered text without reading disk", async () => {
  let diskReads = 0;
  const result = await preferBufferedText("unsaved contents", async () => {
    diskReads += 1;
    return "saved contents";
  });

  assert.equal(result, "unsaved contents");
  assert.equal(diskReads, 0);
});

test("treats an empty unsaved buffer as authoritative", async () => {
  const result = await preferBufferedText("", async () => "saved contents");
  assert.equal(result, "");
});

test("falls back to disk when no matching buffer is open", async () => {
  const result = await preferBufferedText(undefined, async () => "saved contents");
  assert.equal(result, "saved contents");
});

test("blocks dirty output buffers and non-generated existing files", () => {
  assert.equal(
    outputConflict({ exists: true, isDirty: true, contents: GENERATED_MARKER }),
    "dirty-buffer"
  );
  assert.equal(
    outputConflict({ exists: true, isDirty: false, contents: "user-authored" }),
    "unowned-file"
  );
});

test("allows new outputs and marked generated outputs", () => {
  assert.equal(outputConflict({ exists: false, isDirty: false }), undefined);
  assert.equal(
    outputConflict({ exists: true, isDirty: false, contents: GENERATED_MARKER }),
    undefined
  );
});

test("offers bundling for every remote upload action when supported", () => {
  assert.deepEqual(remoteUploadChoices("Create", true), [
    "Create",
    "Bundle & Create"
  ]);
  assert.deepEqual(remoteUploadChoices("Upload", true), [
    "Upload",
    "Bundle & Upload"
  ]);
  assert.deepEqual(remoteUploadChoices("Overwrite", true), [
    "Overwrite",
    "Bundle & Overwrite"
  ]);
  assert.equal(bundleUploadLabel("Upload"), "Bundle & Upload");
});

test("keeps the direct action when the active editor cannot be bundled", () => {
  assert.deepEqual(remoteUploadChoices("Create", false), ["Create"]);
  assert.deepEqual(remoteUploadChoices("Upload", false), ["Upload"]);
  assert.deepEqual(remoteUploadChoices("Overwrite", false), ["Overwrite"]);
});
