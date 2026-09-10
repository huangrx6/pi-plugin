import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EXTENSION_VERSION } from "../extensions/policy-engine/version.js";

test("runtime, package and changelog versions stay aligned", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const changelog = readFileSync(
    new URL("../CHANGELOG.md", import.meta.url),
    "utf8",
  );
  const latest = changelog.match(/^## ([^ ]+)/m)?.[1];

  assert.equal(EXTENSION_VERSION, packageJson.version);
  assert.equal(latest, packageJson.version);
});
