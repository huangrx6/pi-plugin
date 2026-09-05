import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { globalConfigPath } from "./paths.js";
import { validateShape } from "./schema.js";

// Persist only explicitly selected settings; unrelated global configuration is preserved.
export async function saveSelections({
  mode,
  recognition,
}) {
  const patch = mode ? { mode } : {};
  if (!Object.keys(patch).length && !recognition)
    throw new Error(
      "Select a mode or recognition option before saving.",
    );
  const path = globalConfigPath();
  const readPath = path;
  let current = {};
  try {
    current = JSON.parse(await readFile(readPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT")
      throw new Error(`Cannot update invalid configuration: ${e.message}`);
  }
  if (!current || typeof current !== "object" || Array.isArray(current))
    throw new Error("Configuration must be an object");
  const next = { ...current, ...patch };
  if (recognition)
    next.recognition = { ...current.recognition, ...recognition };
  const issues = validateShape(next);
  if (issues.length) throw new Error(issues.map((i) => i.message).join("; "));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return path;
}
