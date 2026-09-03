/**
 * workflow-format.test.ts — P4-C2 (workflow syntax wording).
 *
 * LOCK 30: workflow parser and wiring own no workflow UX strings.
 * Workflow syntax wording belongs to the additive P4 workflow formatter.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatWorkflowSyntaxError } from "./workflow-format.ts";

describe("workflow-format: syntax-error wording", () => {
 it("'here' → '/todos here takes no arguments.'", () => {
  assert.equal(
   formatWorkflowSyntaxError("here"),
   "/todos here takes no arguments.",
  );
 });
});
