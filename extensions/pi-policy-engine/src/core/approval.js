// Approval-phrase recognition for the strict-workflow state machine.
//
// Scope note (v0.12): this module deliberately contains NO tool-call
// interception. The extension works entirely at the model-behavior layer —
// strict planning injects a PLAN-ONLY instruction and the model is expected
// to stop and ask the user for approval, exactly like a skill that requires
// user confirmation. Whether any given tool call is *permitted* is someone
// else's job (e.g. whatever permission extension the user runs, if any).
// Keeping out of tool_call means this extension composes with anything
// (or nothing) without coordination.

export function isApprovalPrompt(prompt) {
  const text = String(prompt ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (
    /(不批准|先别执行|不要执行|别执行|修改计划|调整计划|重新计划|继续分析|先分析|stop|hold|reject|revise)/i.test(
      text,
    )
  )
    return false;

  const strong =
    /^(批准|通过|执行|开始执行|可以执行|继续执行|approve|approved|proceed|go ahead|do it)(?:[，,。.!！\s]|$)/i;
  if (strong.test(text)) return true;

  return /^(继续|开始吧|可以|就这样)[。.!！\s]*$/i.test(text);
}

export function isPlanRevisionPrompt(prompt) {
  const text = String(prompt ?? "")
    .trim()
    .toLowerCase();
  return /(不批准|先别执行|不要执行|修改计划|调整计划|重新计划|revise|change the plan|hold|stop)/i.test(
    text,
  );
}
