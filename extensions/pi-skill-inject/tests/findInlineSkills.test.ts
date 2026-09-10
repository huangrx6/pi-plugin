/**
 * findInlineSkills.test.ts — P2.4 回归覆盖深化
 *
 * 锁定 findInlineSkills 的核心不变量:
 *   A. URL-ish 跳过("//" 协议头、":" 端口号)
 *   B. 大小写回退(exact → loose)
 *   C. 去重(同 skill 不同 token 形式只入一次)
 *   D. 多 token 顺序保留
 *   E. 边缘:空输入、无 skill、空 token、bare "/"
 *
 * 注意: SKILL_TOKEN_RE 的正向后瞻包含 `|$`(字符串末尾也视为
 * token 边界),所以"整个字符串就是 token"也会匹配。这是
 * 已实现行为,本测试不挑战;只锁定"实际外部行为"以防回归。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findInlineSkills } from "../index.ts";

function skillsFixture() {
  return [
    {
      name: "design-api-contracts",
      description: "API design",
      path: "/p1",
      scope: "user" as const,
      source: "",
    },
    {
      name: "token-economy",
      description: "Token usage",
      path: "/p2",
      scope: "user" as const,
      source: "",
    },
    {
      name: "release-notes",
      description: "Release notes",
      path: "/p3",
      scope: "user" as const,
      source: "",
    },
  ];
}

describe("findInlineSkills: URL-ish skip", () => {
  it("skips '//' protocol head (e.g. https://foo)", () => {
    const out = findInlineSkills(
      "https://design-api-contracts",
      skillsFixture(),
    );
    assert.deepEqual(
      out,
      [],
      "https://design-api-contracts 不应触发 skill 注入（// 前缀）",
    );
  });
  it("skips ':' port-style prefix (e.g. host:token-economy)", () => {
    const out = findInlineSkills("localhost:token-economy", skillsFixture());
    assert.deepEqual(out, []);
  });
  it("still matches plain /token (no leading // or :)", () => {
    const out = findInlineSkills(
      "see /design-api-contracts for spec",
      skillsFixture(),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "design-api-contracts");
  });
});

describe("findInlineSkills: case-insensitive fallback", () => {
  it("exact match on lowercase", () => {
    const out = findInlineSkills("/design-api-contracts", skillsFixture());
    assert.equal(out[0]?.name, "design-api-contracts");
  });
  it("loose match on mixed case (token-economy → /Token-Economy)", () => {
    const out = findInlineSkills("/Token-Economy", skillsFixture());
    assert.equal(out.length, 1);
    assert.equal(out[0]?.name, "token-economy");
  });
  it("loose match on uppercase", () => {
    const out = findInlineSkills("/RELEASE-NOTES", skillsFixture());
    assert.equal(out[0]?.name, "release-notes");
  });
  it("returns [] for non-existent skill", () => {
    const out = findInlineSkills("/nonexistent-skill", skillsFixture());
    assert.deepEqual(out, []);
  });
});

describe("findInlineSkills: dedup", () => {
  it("same token twice → one entry", () => {
    const out = findInlineSkills(
      "/design-api-contracts /design-api-contracts",
      skillsFixture(),
    );
    assert.equal(out.length, 1);
  });
  it("case variations dedup", () => {
    const out = findInlineSkills(
      "/design-api-contracts /Design-API-Contracts",
      skillsFixture(),
    );
    assert.equal(out.length, 1, "同一 skill 不同大小写只入一次");
  });
});

describe("findInlineSkills: multiple tokens in document order", () => {
  it("returns matched skills in input order", () => {
    const out = findInlineSkills(
      "/token-economy then /design-api-contracts then /release-notes",
      skillsFixture(),
    );
    assert.deepEqual(
      out.map((s) => s.name),
      ["token-economy", "design-api-contracts", "release-notes"],
    );
  });
  it("URL-ish skip does not affect other matches in same text", () => {
    const out = findInlineSkills(
      "https://design-api-contracts and /token-economy",
      skillsFixture(),
    );
    assert.deepEqual(
      out.map((s) => s.name),
      ["token-economy"],
    );
  });
});

describe("findInlineSkills: edge cases", () => {
  it("empty text → []", () => {
    assert.deepEqual(findInlineSkills("", skillsFixture()), []);
  });
  it("text without any /token → []", () => {
    assert.deepEqual(findInlineSkills("hello world", skillsFixture()), []);
  });
  it("bare slash alone → [] (no token after /)", () => {
    assert.deepEqual(findInlineSkills("/", skillsFixture()), []);
  });
  it("empty skills array → []", () => {
    assert.deepEqual(findInlineSkills("/design-api-contracts", []), []);
  });
});
