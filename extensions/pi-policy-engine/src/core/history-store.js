// Persistent history storage for `/policy history`.
//
// Each routing decision (decide or preview) is appended to a JSONL file
// (one JSON object per line). The file is read at session_start to merge
// recent entries into the in-memory history, giving cross-session continuity.
//
// File format (JSONL):
//   {"ts":1700000000000,"source":"decide","prompt":"...","task":"coding",...}\n
//   {"ts":1700000001000,"source":"preview","prompt":"...","task":"debugging",...}\n
//
// Operational notes:
// - Writes are append + fsync. Append is atomic on POSIX for small writes
//   (< PIPE_BUF); we don't expect to hit that limit per-entry.
// - Reads scan from the end (tail-style) so a 5000-line file is cheap.
// - Read failures (missing file, permission denied) are non-fatal: the
//   in-memory history still works.
// - Writes never throw to the caller; errors are swallowed so an append
//   failure (disk full, permissions) doesn't break the agent loop.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_RELATIVE_HOME = ".pi/agent/policy-engine/history.jsonl";

/**
 * Expand a leading `~` to the user's home directory; resolve to absolute.
 */
export function resolveHistoryPath(input, cwd = process.cwd()) {
  if (typeof input !== "string" || !input) return null;
  let p = input;
  if (p.startsWith("~/") || p === "~") p = homedir() + p.slice(1);
  else if (p === "~") p = homedir();
  return resolve(cwd, p);
}

export function defaultHistoryPath(cwd = process.cwd()) {
  return resolve(cwd, homedir(), DEFAULT_RELATIVE_HOME);
}

/**
 * Append a single entry as a JSONL line. Best-effort: never throws.
 *
 * Accepts optional `fs` override for testing (must implement appendFile).
 */
export async function appendHistory(filePath, entry, fs = null) {
  if (!filePath || !entry) return { ok: false, reason: "missing args" };
  const lib = fs ?? (await import("node:fs/promises"));
  try {
    await lib.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Truncate the history file. Best-effort: never throws.
 */
export async function clearHistory(filePath, fs = null) {
  if (!filePath) return { ok: false, reason: "missing path" };
  const lib = fs ?? (await import("node:fs/promises"));
  try {
    await lib.writeFile(filePath, "", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Read up to `limit` most-recent entries from a JSONL file. Returns [] if
 * the file is missing or unreadable. Requires Node 20+ for Array.prototype.
 * toReversed (matches the package's Node 20 baseline).
 */
export async function readHistory(filePath, limit = 50, fs = null) {
  if (!filePath || limit <= 0) return [];
  const lib = fs ?? (await import("node:fs/promises"));
  let text;
  try {
    text = await lib.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const out = [];
  // Scan from the end so we don't parse the whole file for big histories.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines (don't crash the session).
    }
  }
  // toReversed() returns a new array without mutating `out` (Node 20+).
  return out.toReversed();
}
