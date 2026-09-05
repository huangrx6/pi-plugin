import {
  strictPolicyId,
  composeAllPolicies,
  renderPolicyBlock,
} from "../../src/core/loader.js";
import { loadModelRules, modelPolicyId } from "../../src/core/router.js";
export function buildTurnBlock({ packageRoot, cwd, turn, model }) {
  const { decision, config, phase } = turn;
  decision.modelPolicy = modelPolicyId(model, [
    ...(config.modelRules ?? []),
    ...loadModelRules(packageRoot),
  ]);
  const composed = composeAllPolicies({
    packageRoot,
    cwd,
    decision,
    config,
    phase,
  });
  decision.loadedPolicies = [
    ...composed.policies,
    ...composed.projectPolicies,
  ].map((p) => p.id);
  decision.truncatedPolicies = composed.truncated;
  decision.missingPolicies = composed.missing;
  decision.droppedProjectPolicies = composed.projectSkipped;
  decision.policyBytes = composed.builtInBytes + composed.projectBytes;
  decision.policyBudget = config.policyMaxBytes;
  const required = [
    ...(decision.intentPolicy === "contextual" ? ["intent.contextual"] : []),
    `intent.${decision.executionIntent ?? "unclear"}`,
  ];
  if (decision.rigor === "strict")
    required.push(strictPolicyId(decision, phase));
  const blocked =
    decision.preflightBlocked ||
    required.some((id) => !decision.loadedPolicies.includes(id));
  const block = renderPolicyBlock({ decision, ...composed, phase });
  const injected = [
    block,
    turn.note,
    phase === "planning"
      ? '## Plan reporting protocol\nOnly after producing a concrete plan, append one ```policy-plan JSON block with taskId and planVersion from the current task contract, goal (string), and steps (nonempty array of {"action":"specific work","verification":"check and expected result"}). Do not emit this block for a question, missing information, or failure. This records a proposed plan; it does not prove execution or verification.'
      : "",
    blocked
      ? decision.preflightBlocked
        ? "## Intent preflight blocked\nThe model-first intent recognition did not produce a valid result. Do not execute or modify anything. Explain that intent recognition failed and ask the user to retry."
        : "## Policy configuration blocked\nRequired intent or phase policy is unavailable. Do not execute changes. Report the missing or excluded policies and budget problem to the user."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  decision.injectedBytes = Buffer.byteLength(injected);
  return { ...composed, injected, blocked };
}
