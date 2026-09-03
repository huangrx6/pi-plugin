/**
 * parse-todos-command.ts — P0-B B3 /todos read grammar.
 *
 * Pure: string in, AST out. Does not touch state, projection, or
 * persistence. FROZEN — only additive fixes (e.g. additional
 * canonical usage strings) without behavior change.
 *
 * Module invariants (LOCK):
 *   1. Never reads or mutates TaskState.
 *   2. Numeric tokens route to `detail`; named verbs route to their
 *      respective read renderer.
 *   3. Unknown verbs route to `unknown` and surface canonical
 *      "Usage:" line — callers should render this as error.
 */

export type TodosCommand =
 | { command: "default" }
 | { command: "detail"; taskId: number }
 | { command: "ready" }
 | { command: "blocked" }
 | { command: "completed" }
 | { command: "archived" }
 | { command: "all" }
 | { command: "unknown" };

const ID_PATTERN = /^[0-9]+$/;

export function parseTodosCommand(raw: unknown): TodosCommand {
 const s = String(raw ?? "").trim();
 if (s === "") return { command: "default" };
 const firstToken = s.split(/\s+/)[0];
 if (firstToken === undefined) return { command: "default" };

 switch (firstToken) {
  case "ready":
   return { command: "ready" };
  case "blocked":
   return { command: "blocked" };
  case "completed":
   return { command: "completed" };
  case "archived":
   return { command: "archived" };
  case "all":
   return { command: "all" };
  default:
   if (ID_PATTERN.test(firstToken)) {
    const n = Number(firstToken);
    if (Number.isFinite(n) && n > 0) {
     return { command: "detail", taskId: n };
    }
   }
   return { command: "unknown" };
 }
}
