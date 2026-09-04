/**
 * runtime-persistence.ts — P3-E (production integration policy).
 *
 * Constructs the production durable wiring:
 *   ScopeKey resolver + DurableTodoStore + durable root directory.
 *
 * Does NOT own TaskState, domain semantics, or CLI UX.
 *
 * Module invariants (P3-E LOCK):
 *   1. Default durable root = extensions-data/pi-todo/state under getAgentDir().
 *      getAgentDir respects PI_CODING_AGENT_DIR; default is ~/.pi/agent.
 *   2. P3-C workspace resolver + P3-B file backend are the canonical
 *      production wiring.
 *   3. Overridable for tests (durableStore / scopeResolver / rootDir).
 *   4. No TaskState, no domain types, no CLI UX.
 *   5. Type imports are anchored at the contract / interface modules,
 *      not at concrete factory modules (P3-E LOCK §31).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as piAgent from "@earendil-works/pi-coding-agent";
// P3-E note: SDK index.d.ts re-exports getAgentDir from ./config.ts, but
// the tsc module resolution occasionally flags the named export. Falling
// back to namespace access keeps runtime + types consistent.
type PiAgentExports = {
 getAgentDir: () => string;
};
// SAFETY: SDK index.d.ts declares getAgentDir but tsc module resolution
// sometimes rejects the named export. Namespace access via the runtime
// ESM export is verified at import time — if the function is missing,
// the call below throws TypeError immediately on first use.
const agentExports = piAgent as unknown as PiAgentExports;
const getAgentDir = agentExports.getAgentDir;
import { createFileDurableTodoStore } from "./file-durable-store.ts";
import { createWorkspaceScopeKeyResolver } from "./workspace-scope.ts";
import type { ScopeKeyResolver } from "./persistence-contract.ts";
import type { DurableTodoStore } from "./durable-store.ts";

export interface TodoRuntimePersistence {
 readonly scopeResolver: ScopeKeyResolver<unknown>;
 readonly durableStore: DurableTodoStore;
 readonly rootDir: string;
}

export interface TodoRuntimePersistenceOptions {
 readonly rootDir?: string;
 readonly durableStore?: DurableTodoStore;
 readonly scopeResolver?: ScopeKeyResolver<unknown>;
}

/**
 * Construct the production durable wiring.
 *
 * Defaults: extensions-data/pi-todo/state under getAgentDir(), file backend, workspace:v1
 * resolver. Overrides exist for tests; production callers should not
 * pass any options.
 */
export function createProductionTodoPersistence(
 options: TodoRuntimePersistenceOptions = {},
): TodoRuntimePersistence {
 const rootDir = options.rootDir ?? resolveDefaultTodoRoot();
 const durableStore =
  options.durableStore ?? createFileDurableTodoStore({ rootDir });
 const scopeResolver =
  options.scopeResolver ?? createWorkspaceScopeKeyResolver();
 return { scopeResolver, durableStore, rootDir };
}

/** Keep legacy state authoritative until it has been migrated offline. */
export function resolveDefaultTodoRoot(agentDir = getAgentDir()): string {
 const rootDir = join(agentDir, "extensions-data", "pi-todo", "state");
 const legacyRoot = join(agentDir, "pi-todo");
 return !existsSync(rootDir) && existsSync(legacyRoot) ? legacyRoot : rootDir;
}
