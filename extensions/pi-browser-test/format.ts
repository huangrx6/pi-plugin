import type { ValidationIssue, ValidationResult } from "./types.ts";

function clean(value: string): string {
  return value
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "");
}

function issueLines(issues: ValidationIssue[]): string[] {
  const shown = issues.slice(0, 20);
  const lines = shown.map((entry) => `  ${entry.severity === "error" ? "×" : "!"} ${entry.code} ${entry.path || "/"} — ${entry.message}`);
  if (issues.length > shown.length) lines.push(`  … 另有 ${issues.length - shown.length} 项，请先修复以上问题后重试`);
  return lines;
}

export function formatValidation(result: ValidationResult, specPath: string, registryPath: string): string {
  const errors = [...result.schemaIssues, ...result.semanticIssues].filter((entry) => entry.severity === "error");
  const warnings = result.semanticIssues.filter((entry) => entry.severity === "warning");
  const lines = [
    result.ok ? "Test Spec 校验通过" : "Test Spec 校验失败",
    `规范：${specPath}`,
    `能力注册表：${registryPath}`,
  ];
  if (result.hash) lines.push(`TestSpecHash：${result.hash}`);
  if (errors.length) lines.push(`错误 ${errors.length}：`, ...issueLines(errors));
  if (warnings.length) lines.push(`警告 ${warnings.length}：`, ...issueLines(warnings));
  if (result.ok && !warnings.length) lines.push("JSON Schema 结构与 TS-001～TS-015 语义规则均通过。");
  return clean(lines.join("\n"));
}

export function formatUsage(schemaPath: string): string {
  return clean([
    "Pi Browser Test · Test Spec v1.0",
    "校验：/browser-test validate <spec.json> [--registry <capability-registry.json>]",
    "摘要：/browser-test hash <spec.json> [--registry <capability-registry.json>]",
    `JSON Schema：${schemaPath}`,
    "默认注册表：<当前项目>/.pi/browser-test/capability-registry.json",
    "此阶段只校验业务测试语义，不执行浏览器操作。",
  ].join("\n"));
}
