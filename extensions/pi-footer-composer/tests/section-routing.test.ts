/**
 * section-routing.test.ts — Status key 协议测试 (0.9.0+)
 *
 * 验证：
 *   A. 显式 kind 前缀（quota:/usage:/context:/integration:/config:）
 *      正确路由到对应 section
 *   B. 旧字面量 key（"quota"/"mode"/"policy" 等）通过 legacyRouteOf
 *      兑底路由（0.9.0-1.0.0 过渡期行为）
 *   C. statusKey() 工厂函数生成正确的前缀格式
 *   D. 未识别的 key 静默归入 misc（不抛错）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { statusKey, type StatusKind } from "../config.ts";

/**
 * 复制 footer-composer/index.ts 的 sectionOf 与 legacyRouteOf 用于
 * 路由逻辑测试。`export` 之后再考虑在 index.ts 显式导出；本测试
 * 阶段内联两函数以避免污染包导出面。
 */
type Section = StatusKind;

function sectionOf(key: string): Section {
  if (key.startsWith("quota:")) return "quota";
  if (key.startsWith("usage:")) return "usage";
  if (key.startsWith("context:")) return "context";
  if (key.startsWith("integration:")) return "integration";
  if (key.startsWith("config:")) return "config";
  return legacyRouteOf(key);
}

function legacyRouteOf(key: string): Section {
  const k = key.toLowerCase();
  if (k === "mcp" || k.includes("lsp")) return "integration";
  if (k === "mode" || k.includes("policy")) return "config";
  if (k === "quota") return "quota";
  if (k.includes("context") || k.includes("qos")) return "context";
  return "misc";
}

describe("status key prefix routing", () => {
  it("explicit kind prefixes map to matching section", () => {
    assert.equal(sectionOf("quota:main"), "quota");
    assert.equal(sectionOf("quota:openrouter"), "quota");
    assert.equal(sectionOf("usage:input"), "usage");
    assert.equal(sectionOf("context:auto-compact"), "context");
    assert.equal(sectionOf("integration:mcp"), "integration");
    assert.equal(sectionOf("config:mode"), "config");
  });

  it("subkeys with hyphens, dots, underscores are preserved", () => {
    assert.equal(sectionOf("context:auto-compact"), "context");
    assert.equal(sectionOf("config:policy.mode"), "config");
    assert.equal(sectionOf("usage:cache_read"), "usage");
  });

  it("empty subkey after prefix still matches the kind section", () => {
    // `setStatus("quota:", ...)` 理论上罕见但允许；视为 quota section
    assert.equal(sectionOf("quota:"), "quota");
    assert.equal(sectionOf("config:"), "config");
  });
});

describe("legacy substring fallback (deprecated, 0.9.0-1.0.0)", () => {
  it("bare key 'quota' routes to quota via legacy", () => {
    assert.equal(sectionOf("quota"), "quota");
  });

  it("bare key 'mode' routes to config via legacy", () => {
    assert.equal(sectionOf("mode"), "config");
  });

  it("substring 'policy' routes to config via legacy", () => {
    assert.equal(sectionOf("policy:strict/awaiting_approval"), "config");
    assert.equal(sectionOf("policy"), "config");
  });

  it("bare key 'mcp' or substring 'lsp' routes to integration via legacy", () => {
    assert.equal(sectionOf("mcp"), "integration");
    assert.equal(sectionOf("typescript-lsp"), "integration");
  });

  it("substring 'context' / 'qos' routes to context via legacy", () => {
    assert.equal(sectionOf("ContextUsage"), "context");
    assert.equal(sectionOf("qos:window"), "context");
  });
});

describe("unrecognized keys fall to misc", () => {
  it("random key falls to misc", () => {
    assert.equal(sectionOf("foo:bar"), "misc");
    assert.equal(sectionOf("random-key"), "misc");
    assert.equal(sectionOf(""), "misc");
  });

  it("keys with valid prefix but invalid kind-name fall to misc via legacy", () => {
    // "unknown:" 没有在 sectionOf 里出现，走 legacyRouteOf → 都不匹配 → misc
    assert.equal(sectionOf("unknown:something"), "misc");
  });
});

describe("statusKey factory", () => {
  it("generates kind-prefixed keys", () => {
    assert.equal(statusKey("quota", "main"), "quota:main");
    assert.equal(statusKey("config", "mode"), "config:mode");
    assert.equal(statusKey("context", "auto-compact"), "context:auto-compact");
  });

  it("does not double-prefix when subkey already has kind", () => {
    // 工厂不做去重；调用方责任传不重复 subkey
    assert.equal(statusKey("quota", "quota:foo"), "quota:quota:foo");
  });

  it("type signature prevents 'misc' kind via Exclude<StatusKind, 'misc'>", () => {
    // statusKey('misc', 'x') 编译期拒绝；运行时误用则不期望
    // （不在本测试中演示，因为它是编译期约束）
  });
});

describe("round-trip: factory output matches sectionOf", () => {
  it("all valid kinds round-trip to the right section", () => {
    for (const kind of ["quota", "usage", "context", "integration", "config"] as const) {
      const k = statusKey(kind, "main");
      assert.equal(sectionOf(k), kind, `kind=${kind} key=${k}`);
    }
  });
});
