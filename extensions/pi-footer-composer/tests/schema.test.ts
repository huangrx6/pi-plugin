import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { defaultFooterConfig, resolveFooterConfig } from "../config.ts";
test("schema, defaults and shipped example agree", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8"));
  const validate = new (Ajv as any)({ allErrors: true }).compile(schema);
  const example = JSON.parse(readFileSync(new URL("../examples/config.json", import.meta.url), "utf8"));
  for (const value of [defaultFooterConfig(), example, {}]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.deepEqual(resolveFooterConfig(value), defaultFooterConfig());
  }
  for (const value of [{ version: 4 }, { views: {} }, { more: { sections: [{ label: "label" }] } }, { style: { panelWidth: 101 } }]) assert.equal(validate(value), false);
});
