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
// - Writes are appends via fs.promises.appendFile (buffered, not fsync'd —
//   a crash may lose the last entry, which is acceptable for routing
//   history). Appends are atomic on POSIX for small writes (< PIPE_BUF).
// - The parent directory is created (recursive, 0o700) and the file is
//   created 0o600: history contains prompt excerpts, treat it as private.
// - Reads scan from the end (tail-style) so a 5000-line file is cheap.
// - Read failures (missing file, permission denied) are non-fatal: the
//   in-memory history still works.
// - Writes never throw to the caller; errors are swallowed so an append
//   failure (disk full, permissions) doesn't break the agent loop.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
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
 * Creates the parent directory (0o700) and the file (0o600) if missing —
 * without this, the default ~/.pi/... path silently failed to persist.
 *
 * Accepts optional `fs` override for testing (must implement appendFile,
 * mkdir, and optionally chmod).
 */
// v0.20: disk rotation. historyMaxEntries only capped the in-memory read;
// the file grew forever. Once the file exceeds ROTATE_THRESHOLD bytes it is
// compacted to the most recent ROTATE_KEEP lines. Stats are size-based so
// the common path (file small) costs one stat, not a full read.
const ROTATE_THRESHOLD = 512 * 1024; // 512 KB
const ROTATE_KEEP = 1000; // entries kept after compaction

async function rotateIfNeeded(filePath, lib) {
  if (typeof lib.stat !== "function") return; // fs mocks without stat
  let size = 0;
  try {
    size = (await lib.stat(filePath)).size;
  } catch {
    return; // missing file is fine
  }
  if (size <= ROTATE_THRESHOLD) return;
  let text;
  try {
    text = await lib.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const kept = lines.slice(-ROTATE_KEEP).join("\n") + "\n";
  try {
    await lib.writeFile(filePath, kept, "utf8");
  } catch {
    // Compaction failure is non-fatal — the append still proceeds.
  }
}

export async function appendHistory(filePath, entry, fs = null) {
  if (!filePath || !entry) return { ok: false, reason: "missing args" };
  const lib = fs ?? (await import("node:fs/promises"));
  try {
    try {
      await lib.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    } catch {
      // mkdir failure falls through to appendFile, which reports it.
    }
    await rotateIfNeeded(filePath, lib);
    await lib.appendFile(filePath, JSON.stringify(entry) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
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

// ---------------------------------------------------------------------------
// Strict-plan state across sessions (v0.20)
// ---------------------------------------------------------------------------
//
// session_start resets state, so a strict plan left at awaiting_approval
// died with the process: plan in the evening, /resume the next morning,
// "批准" -> fresh classification. The awaiting state is now persisted next
// to the history file and restored on session_start (cwd-matched, max one
// week old). Concurrency caveat: two live sessions in the SAME project
// share the file — last writer wins. The failure direction is safe: a
// stale restore keeps awaiting_approval (asks again) and never releases
// execution on its own.

/**
 * Path of the strict-state file next to a resolved history file, NAMESPACED
 * by project cwd (v0.21): with the default shared historyFile, all projects
 * wrote one strict-state.json and the last project to save stole the
 * restore (verified: A saves, B saves, A can no longer restore). The
 * loadStrictState cwd check remains as a second layer.
 */
export function strictStatePath(historyFilePath, cwd = null) {
  if (typeof historyFilePath !== "string" || !historyFilePath) return null;
  const dir = dirname(historyFilePath);
  if (typeof cwd !== "string" || !cwd) {
    return join(dir, "strict-state.json"); // caller without cwd: legacy name
  }
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(dir, `strict-state-${hash}.json`);
}

// Only routing-relevant decision fields are persisted — bookkeeping
// (loadedPolicies etc.) is recomputed per turn anyway.
// v0.21: modelPolicy is NOT persisted — it is recomputed from the CURRENT
// model on every use, so a plan drafted under MiniMax-M3 and approved after
// /model deepseek gets the right adaptation instead of a stale one.
const STRICT_DECISION_FIELDS = [
  "taskType",
  "risk",
  "confidence",
  "executionIntent",
  "domains",
  "concerns",
  "rigor",
  "flow",
  "profile",
  "reasons",
];

export async function saveStrictState(filePath, state, fs = null) {
  if (!filePath || !state?.decision)
    return { ok: false, reason: "missing args" };
  const lib = fs ?? (await import("node:fs/promises"));
  const decision = {};
  for (const k of STRICT_DECISION_FIELDS) decision[k] = state.decision?.[k];
  const payload = {
    version: 1,
    cwd: state.cwd,
    ts: Date.now(),
    phase: "awaiting_approval",
    decision,
  };
  try {
    try {
      await lib.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    } catch {
      // mkdir failure falls through to writeFile, which reports it.
    }
    await lib.writeFile(filePath, JSON.stringify(payload) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Restore a persisted awaiting_approval plan. Returns
 * { phase: "awaiting_approval", decision } or null (missing / stale /
 * different project / malformed). Never throws.
 */
export async function loadStrictState(
  filePath,
  { cwd, maxAgeMs = 7 * 24 * 3600 * 1000 } = {},
  fs = null,
) {
  if (!filePath) return null;
  const lib = fs ?? (await import("node:fs/promises"));
  let text;
  try {
    text = await lib.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== 1) return null;
    if (parsed?.phase !== "awaiting_approval") return null;
    if (!parsed?.decision?.rigor) return null;
    if (typeof cwd === "string" && parsed.cwd !== cwd) return null;
    if (typeof parsed?.ts === "number" && Date.now() - parsed.ts > maxAgeMs) {
      return null;
    }
    // v0.21: strip legacy modelPolicy (v0.20 files persisted it); it is
    // recomputed from the CURRENT model at use time.
    if (parsed.decision && "modelPolicy" in parsed.decision) {
      delete parsed.decision.modelPolicy;
    }
    return { phase: "awaiting_approval", decision: parsed.decision };
  } catch {
    return null;
  }
}

export async function clearStrictState(filePath, fs = null) {
  if (!filePath) return { ok: false, reason: "missing path" };
  const lib = fs ?? (await import("node:fs/promises"));
  try {
    await lib.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Prune stale namespaced strict-state files (v0.24).
 *
 * Every project cwd gets its own strict-state-<hash>.json and nothing
 * ever removed them — 20+ stale files (some empty, some months old)
 * accumulated next to the history. Restores already ignore files older
 * than maxAgeMs; this actually deletes them.
 *
 * Only files matching strict-state-<16-hex>.json (or the legacy
 * strict-state.json) in the SAME directory as the history file are
 * considered. Best-effort: never throws, returns the removal count.
 */
export async function pruneStrictStates(
  historyFilePath,
  { maxAgeMs = 14 * 24 * 3600 * 1000 } = {},
  fs = null,
) {
  if (typeof historyFilePath !== "string" || !historyFilePath) return 0;
  const lib = fs ?? (await import("node:fs/promises"));
  const dir = dirname(historyFilePath);
  let names;
  try {
    names = await lib.readdir(dir);
  } catch {
    return 0;
  }
  const STALE_RE = /^strict-state(?:-[0-9a-f]{16})?\.json$/;
  let removed = 0;
  for (const name of names) {
    if (!STALE_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const st = await lib.stat(full);
      const birth = Math.max(
        typeof st.birthtimeMs === "number" ? st.birthtimeMs : 0,
        typeof st.mtimeMs === "number" ? st.mtimeMs : 0,
      );
      if (Date.now() - birth > maxAgeMs) {
        await lib.unlink(full);
        removed++;
      }
    } catch {
      // stat/unlink race or permissions — skip this file.
    }
  }
  return removed;
}
