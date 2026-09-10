import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { resolveFooterConfig } from "../config.ts";

const root = process.cwd();
const schema = JSON.parse(readFileSync(join(root, "schema/config.schema.json"), "utf8"));
const example = JSON.parse(readFileSync(join(root, "examples/config.json"), "utf8"));

test("published JSON Schema compiles and validates the complete example", () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  const config = resolveFooterConfig(example);
  assert.equal(config.views.compact.rows.length, 2);
  assert.equal(config.views.overview.renderer, "bands");
});

test("published JSON Schema rejects unknown sources and settings", () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate({ style: { magicGap: 4 } }), false);
  assert.equal(validate({ views: { compact: { rows: [[{ label: "X", fields: ["unknown"] }]] } } }), false);
});
