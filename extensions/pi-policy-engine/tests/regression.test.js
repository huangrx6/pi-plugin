// Regression corpus runner: every entry in regression-corpus.json is a
// real misclassification found in this extension. Failures here mean a
// fix regressed — check the `because` field for the original bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTask } from "../src/core/classifier.js";
import { chooseRigor } from "../src/core/router.js";
import { classifyPlanResponse } from "../src/core/approval.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routing = JSON.parse(
  readFileSync(join(root, "config", "routing.json"), "utf8"),
);
const corpus = JSON.parse(
  readFileSync(join(root, "tests", "regression-corpus.json"), "utf8"),
);

for (const { prompt, expect, because } of corpus.cases) {
  test(`corpus: ${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}`, () => {
    if (expect.planResponse !== undefined) {
      assert.equal(
        classifyPlanResponse(prompt),
        expect.planResponse,
        `${because} (planResponse)`,
      );
      return;
    }
    const x = classifyTask(prompt, routing, []);
    if (expect.taskType !== undefined) {
      assert.equal(x.taskType, expect.taskType, `${because} (taskType)`);
    }
    if (expect.risk !== undefined) {
      assert.equal(x.risk, expect.risk, `${because} (risk)`);
    }
    if (expect.executionIntent !== undefined) {
      assert.equal(
        x.executionIntent,
        expect.executionIntent,
        `${because} (executionIntent)`,
      );
    }
    if (expect.workflow !== undefined) {
      assert.equal(
        chooseRigor(x, "auto"),
        expect.workflow,
        `${because} (workflow)`,
      );
    }
    if (expect.domainsIncludes !== undefined) {
      for (const d of expect.domainsIncludes) {
        assert.ok(
          x.domains.includes(d),
          `${because} (expected domain ${d}, got ${x.domains.join(",")})`,
        );
      }
      for (const d of expect.domainsExcludes ?? []) {
        assert.ok(
          !x.domains.includes(d),
          `${because} (domain ${d} must NOT load, got ${x.domains.join(",")})`,
        );
      }
    }
  });
}
