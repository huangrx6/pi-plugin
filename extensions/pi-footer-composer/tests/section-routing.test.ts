import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusKey } from "../config.ts";
import { sectionOf } from "../routing.ts";

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

describe("unrecognized keys fall to misc", () => {
  it("random key falls to misc", () => {
    assert.equal(sectionOf("foo:bar"), "misc");
    assert.equal(sectionOf("random-key"), "misc");
    assert.equal(sectionOf(""), "misc");
  });

  it("keys with valid prefix but invalid kind-name fall to misc", () => {
    // "unknown:" 没有在 sectionOf 里出现 → misc
    assert.equal(sectionOf("unknown:something"), "misc");
  });

  it("legacy bare keys (e.g. 'quota' / 'mode' / 'policy') now fall to misc (1.0.0 迁移窗口结束)", () => {
    // 0.9.0-1.0.0 过渡期 legacyRouteOf 曾把这些映射到具体 section。
    // 1.0.0 移除：未识别的字面量 key 静默归 misc，提示 publisher 升级。
    assert.equal(sectionOf("quota"), "misc");
    assert.equal(sectionOf("mode"), "misc");
    assert.equal(sectionOf("policy"), "misc");
    assert.equal(sectionOf("policy:strict/awaiting_approval"), "misc");
    assert.equal(sectionOf("ContextUsage"), "misc");
    assert.equal(sectionOf("mcp"), "misc");
    assert.equal(sectionOf("typescript-lsp"), "misc");
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
    for (const kind of [
      "quota",
      "usage",
      "context",
      "integration",
      "config",
    ] as const) {
      const k = statusKey(kind, "main");
      assert.equal(sectionOf(k), kind, `kind=${kind} key=${k}`);
    }
  });
});

it("exact configured mappings override prefixes without substring guessing", () => {
  const routes = { external: "integration", "quota:account": "misc" } as const;
  assert.equal(sectionOf("external", routes), "integration");
  assert.equal(sectionOf("external-extra", routes), "misc");
  assert.equal(sectionOf("quota:account", routes), "misc");
  assert.equal(sectionOf("toString", routes), "misc");
});
