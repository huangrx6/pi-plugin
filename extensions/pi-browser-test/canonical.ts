import { createHash } from "node:crypto";
import type { JsonValue, TestSpec } from "./types.ts";

const SET_ARRAY_PATHS: Readonly<Record<string, string | null>> = {
  "/actors": "actorId",
  "/fixtures": "fixtureId",
  "/preconditions": "preconditionId",
  "/tags": null,
};

function canonicalValue(value: JsonValue, path = ""): JsonValue {
  if (Array.isArray(value)) {
    const items = value.map((entry, index) => canonicalValue(entry, `${path}/${index}`));
    if (!Object.hasOwn(SET_ARRAY_PATHS, path)) return items;
    const idKey = SET_ARRAY_PATHS[path];
    return items.toSorted((left, right) => {
      const a = idKey && left && typeof left === "object" && !Array.isArray(left)
        ? String(left[idKey] ?? "") : String(left);
      const b = idKey && right && typeof right === "object" && !Array.isArray(right)
        ? String(right[idKey] ?? "") : String(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, JsonValue>;
    return Object.fromEntries(
      Object.keys(input).toSorted().map((childKey) => [
        childKey,
        canonicalValue(input[childKey]!, `${path}/${childKey}`),
      ]),
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalizeTestSpec(spec: TestSpec): string {
  return JSON.stringify(canonicalValue(spec as unknown as JsonValue));
}

export function hashCanonical(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function testSpecHash(spec: TestSpec): string {
  return hashCanonical(canonicalizeTestSpec(spec));
}
