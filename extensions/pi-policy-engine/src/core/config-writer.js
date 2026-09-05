import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { extensionDirectory, globalConfigPath } from "./paths.js";
import { validateShape } from "./schema.js";

// Persist only explicitly selected settings; unrelated global configuration is preserved.
export async function saveSelections({
  cwd,
  scope,
  mode,
  profile,
  recognition,
}) {
  if (!["global", "project"].includes(scope))
    throw new Error("Use /policy save global|project");
  const patch = { ...(mode ? { mode } : {}), ...(profile ? { profile } : {}) };
  if (!Object.keys(patch).length && !(recognition && scope === "global"))
    throw new Error(
      "Select a mode/profile before saving; recognition is global-only.",
    );
  const path =
    scope === "global"
      ? join(extensionDirectory(), "config.json")
      : join(cwd, ".pi", "policy-engine.json");
  const readPath = scope === "global" ? globalConfigPath() : path;
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
  if (recognition && scope === "global")
    next.semanticFallback = { ...current.semanticFallback, ...recognition };
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
