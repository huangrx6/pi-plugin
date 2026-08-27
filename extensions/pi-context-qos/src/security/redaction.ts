import { matchesGlob, normalize } from "node:path";

import type { ContextQosConfig } from "../types.ts";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(api[_-]?key|token|secret|password|passwd)(\s*[:=]\s*)["']?[^\s"']{8,}/gi, "$1$2[REDACTED]"],
  [/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, "[REDACTED_DSN]"],
];

export interface ArchiveSecurityDecision {
  archive: boolean;
  content: string;
  redacted: boolean;
  reason?: string;
}

export function pathExcluded(
  filePath: string | null,
  config: ContextQosConfig,
): boolean {
  if (!filePath) return false;
  const candidate = normalize(filePath).replaceAll("\\", "/");
  return config.security.excludePatterns.some((pattern) => {
    try {
      return matchesGlob(candidate, pattern) || matchesGlob(`/${candidate}`, pattern);
    } catch {
      return false;
    }
  });
}

export function secureForArchive(
  content: string,
  filePath: string | null,
  config: ContextQosConfig,
): ArchiveSecurityDecision {
  if (pathExcluded(filePath, config)) {
    return {
      archive: false,
      content: "",
      redacted: false,
      reason: "excluded path",
    };
  }
  if (config.security.archiveSecrets) {
    return { archive: true, content, redacted: false };
  }
  let redacted = content;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return {
    archive: true,
    content: redacted,
    redacted: redacted !== content,
  };
}
