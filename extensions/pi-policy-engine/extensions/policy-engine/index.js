// pi-policy-engine extension entry point.
//
// Wires the four pieces of the extension together:
//   - state: mutable runtime state (mode / profile / decision / phase).
//   - commands: /policy subcommand + interactive selector.
//   - lifecycle: pi event handlers (session_start, model_select,
//                before_agent_start, agent_end).
//   - format / helpers / core: pure modules, no pi dependencies.
//
// Intent: keep this file as thin assembly so individual concerns can be
// reviewed and tested in isolation.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { ACTIVITY_TYPE, activityRows } from "./activity.js";
import { createCommandHandler } from "./commands.js";
import { findPackageRoot } from "./helpers.js";
import { registerLifecycleHandlers } from "./lifecycle.js";
import { createState } from "./state.js";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(here);

export default function policyEngine(pi) {
  const state = createState();
  pi.registerEntryRenderer?.(ACTIVITY_TYPE, (entry, options, theme) => ({
    render(width) {
      return activityRows(entry.data, options.expanded, width).map((row) =>
        theme.fg(row.tone, row.text),
      );
    },
    invalidate() {},
  }));

  pi.registerCommand("policy", {
    description:
      "查看策略行为；在一级面板选择自动处理、谨慎处理或关闭策略。",
    handler: createCommandHandler({
      pi,
      packageRoot: PACKAGE_ROOT,
      getState: () => state,
    }),
  });

  registerLifecycleHandlers(pi, {
    packageRoot: PACKAGE_ROOT,
    getState: () => state,
  });
}
