import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS, ENDPOINTS, adapterMatchesModel, subscriptionForProvider } from "../adapters.ts";
import { formatBar } from "../format.ts";
import { percentBarFromLimitRemaining } from "../parse.ts";

function response(t, data: unknown, status = 200) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

test("Moonshot uses domestic API balance, including vouchers, with an explicit endpoint", async t => {
  const calls = response(t, { code: 0, status: true, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } });
  const bars = await ADAPTERS.moonshot.fetch("test-only-key");
  assert.deepEqual(bars, [{ kind: "balance", label: "可用:", amount: 49.58894, currency: "¥" }]);
  assert.equal(calls[0].url, ENDPOINTS.moonshot);
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].options.headers, { Authorization: "Bearer test-only-key" });
  assert.equal(subscriptionForProvider("moonshot"), "moonshot");
  assert.equal(subscriptionForProvider("kimi-code"), "kimi");
});

test("SiliconFlow reads totalBalance, not only the promotional balance", async t => {
  response(t, { code: 20000, status: true, data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" } });
  const [bar] = await ADAPTERS.siliconflow.fetch("test-only");
  assert.deepEqual(bar, { kind: "balance", label: "余额:", amount: 88.88, currency: "¥" });
});

test("OpenRouter account balance is purchased minus used; negatives are preserved", async t => {
  const calls = response(t, { data: { total_credits: 10, total_usage: 12.25 } });
  assert.deepEqual(await ADAPTERS.openrouterAccount.fetch("management-fixture"), [{ kind: "balance", label: "账户剩余:", amount: -2.25, currency: "$" }]);
  assert.equal(calls[0].url, ENDPOINTS.openrouterAccount);
  assert.equal(ADAPTERS.openrouterAccount.apiKeyEnvVar, "OPENROUTER_MANAGEMENT_KEY");
});

test("OpenRouter key allowance and an unlimited key never masquerade as account money", async t => {
  response(t, { data: { limit: null, limit_remaining: null, is_free_tier: true } });
  assert.deepEqual(await ADAPTERS.openrouter.fetch("key"), [{ kind: "text", label: "Key:", text: "未设上限" }]);
});

test("OpenRouter missing remaining allowance is unknown, not unlimited or zero", async t => {
  response(t, { data: { limit: 25, limit_remaining: null } });
  const [bar] = await ADAPTERS.openrouter.fetch("key");
  assert.equal(bar.kind, "balance");
  assert.match(formatBar(bar), /--/);
  assert.doesNotMatch(formatBar(bar), /0\.00|未设上限/);
});

test("DeepSeek unavailable keeps actual amounts and all reported currencies", async t => {
  response(t, { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "-1.20" }, { currency: "USD", total_balance: "0.05" }] });
  assert.deepEqual(await ADAPTERS.deepseek.fetch("key"), [
    { kind: "balance", label: "余额:", amount: -1.2, currency: "¥" },
    { kind: "balance", label: "余额:", amount: 0.05, currency: "$" },
    { kind: "text", label: "状态:", text: "不可调用" },
  ]);
});

test("GLM distinguishes known and null windows and rejects empty windows", async t => {
  response(t, { code: 200, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: null }, { type: "TOKENS_LIMIT", unit: 6, percentage: 23 }] } });
  assert.deepEqual((await ADAPTERS.zhipu.fetch("key")).map(bar => bar.kind === "percentage" ? bar.percent : undefined), [null, 23]);
});

test("MiniMax remaining percent is inverted; missing reset never implies reset now", async t => {
  response(t, { base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 75, current_weekly_remaining_percent: null }] });
  const bars = await ADAPTERS.minimax.fetch("key");
  assert.deepEqual(bars, [{ kind: "percentage", label: "5h:", percent: 25, resetsInMs: undefined }, { kind: "percentage", label: "周:", percent: null, resetsInMs: undefined }]);
});

test("MiniMax never picks an arbitrary model bucket from multiple plans", async t => {
  response(t, { base_resp: { status_code: 0 }, model_remains: [{ model_name: "a", current_interval_remaining_percent: 10 }, { model_name: "b", current_interval_remaining_percent: 80 }] });
  await assert.rejects(ADAPTERS.minimax.fetch("key"), /无法确定/);
});

test("Kimi recognizes minutes and leaves the overall window named 套餐", async t => {
  response(t, { limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "75" } }], usage: { limit: "200", remaining: "50" } });
  assert.deepEqual((await ADAPTERS.kimi.fetch("key")).map(bar => [bar.label, bar.kind === "percentage" ? bar.percent : undefined]), [["5h:", 25], ["套餐:", 75]]);
});

test("Kimi does not equate a duration without units to five hours", async t => {
  response(t, { limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_SECOND" }, detail: { limit: "100", remaining: "75" } }], usage: { limit: "200", remaining: "50" } });
  assert.equal((await ADAPTERS.kimi.fetch("key")).length, 1);
});

test("OpenCode only maps Go, validates windows, and preserves explicit unknowns", async t => {
  response(t, { usage: { rolling: { percent: 10 }, weekly: { percent: null }, monthly: { percent: 22 } } });
  const bars = await ADAPTERS.opencode.fetch("key");
  assert.equal(bars.length, 3);
  assert.equal(subscriptionForProvider("opencode"), null);
  assert.equal(subscriptionForProvider("opencode-go"), "opencode");
});

for (const [name, data] of [
  ["moonshot", { code: 0, status: true, data: { available_balance: "12.3USD" } }],
  ["siliconflow", { code: 20000, status: true, data: { totalBalance: "" } }],
  ["openrouterAccount", { data: { total_credits: false, total_usage: 10 } }],
  ["zhipu", { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 105 }] } }],
] as const) {
  test(`${name}: malformed values are rejected instead of coerced`, async t => {
    response(t, data);
    await assert.rejects(ADAPTERS[name].fetch("key"), /数据格式异常|百分比超出/);
  });
}

test("API domain failure does not leak remote error messages", async t => {
  response(t, { code: 401, status: false, message: "secret-key", data: { available_balance: 100 } });
  await assert.rejects(ADAPTERS.moonshot.fetch("key"), error => error instanceof Error && error.message === "API 余额查询失败");
});

test("region/proxy mismatches are not assumed to share a billing account", () => {
  assert.equal(adapterMatchesModel(ADAPTERS.moonshot, { baseUrl: "https://api.moonshot.ai/v1" }), false);
  assert.equal(adapterMatchesModel(ADAPTERS.siliconflow, { baseUrl: "https://api.siliconflow.cn/v1" }), true);
  assert.equal(adapterMatchesModel(ADAPTERS.minimax, { baseUrl: "https://api.minimax.io/v1" }), false);
  assert.equal(adapterMatchesModel(ADAPTERS.deepseek, { baseUrl: "https://proxy.example/v1" }), false);
});

test("zero/missing limits are unknown, numeric suffixes are rejected", () => {
  const unknown = percentBarFromLimitRemaining({ limit: "0", remaining: "0" }, "套餐:", Date.now());
  assert.equal(unknown.kind === "percentage" && unknown.percent, null);
  assert.throws(() => percentBarFromLimitRemaining({ limit: "100x", remaining: "0" }, "套餐:", Date.now()), /数据格式异常/);
});
