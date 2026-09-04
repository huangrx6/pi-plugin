/** Independent quota panel plus an optional native status summary. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ADAPTERS, subscriptionForProvider } from "./adapters.ts";
import { TREE_THROTTLE_MS, TURN_THROTTLE_MS, WIDGET_KEY } from "./constants.ts";
import { buildQuotaText } from "./format.ts";
import { createMonitor } from "./monitor.ts";
import { quotaDiagnostics, quotaSummary } from "./panel.ts";
import type { ModelLike } from "./types.ts";
export { describeFetchError } from "./monitor.ts";
type StatusCtx = {
  model: ModelLike;
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
};
export default function (pi: ExtensionAPI): void {
  const monitor = createMonitor();
  const account = createMonitor();
  let generation = 0;
  function publish(ctx: StatusCtx): void {
    if (ctx.hasUI === false) return;
    try { ctx.ui.setStatus(WIDGET_KEY, buildQuotaText(monitor.state) ?? undefined); } catch { /* A replaced context owns no current UI. */ }
  }
  function refresh(ctx: StatusCtx, model = ctx.model): Promise<void> {
    return monitor.refresh(model, () => publish(ctx));
  }
  function reset(ctx: StatusCtx) {
    ++generation;
    monitor.invalidate();
    account.invalidate();
    publish(ctx);
  }
  function throttled(ctx: StatusCtx, threshold: number) {
    if (monitor.matches(ctx.model) && Date.now() - monitor.state.lastRefreshAt < threshold) return;
    void refresh(ctx);
  }
  pi.on("model_select", (event, ctx) => { reset(ctx); void refresh(ctx, event.model); });
  pi.on("session_start", (_event, ctx) => { reset(ctx); void refresh(ctx); });
  pi.on("session_tree", (_event, ctx) => { reset(ctx); throttled(ctx, TREE_THROTTLE_MS); });
  pi.on("turn_end", (_event, ctx) => throttled(ctx, TURN_THROTTLE_MS));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.registerCommand("quota", {
    description: "查看当前额度；refresh 刷新；sources 查看数据来源；account 查询 OpenRouter 管理账户余额",
    handler: async (args, ctx: StatusCtx) => {
      const action = args.trim().toLowerCase();
      if (action && !["refresh", "sources", "account"].includes(action)) {
        ctx.ui.notify("/quota 查看额度 · /quota refresh 刷新 · /quota sources 数据来源 · /quota account OpenRouter 账户余额", "info");
        return;
      }
      const epoch = generation;
      const target = action === "account" ? account : monitor;
      const update = () => action === "account" ? account.refresh(ctx.model, () => {}, "openrouterAccount") : refresh(ctx);
      if (action === "sources") {
        const adapterId = subscriptionForProvider(ctx.model?.provider);
        ctx.ui.notify(quotaDiagnostics(monitor.adapter ?? (adapterId ? ADAPTERS[adapterId] : undefined), ctx.model), "info");
        return;
      }
      await update();
      const isTui = (ctx.mode ?? "tui") === "tui" && ctx.hasUI !== false;
      if (!isTui) {
        ctx.ui.notify(quotaSummary(target.state, target.adapter, ctx.model), "info");
        return;
      }
      while (epoch === generation) {
        const options = [
          "刷新",
          ...(action !== "account" && ctx.model?.provider === "openrouter" ? ["查看账户余额（管理 Key）"] : []),
          "数据来源与诊断",
          "关闭",
        ];
        const selected = await ctx.ui.select(quotaSummary(target.state, target.adapter, ctx.model), options);
        if (epoch !== generation || !selected || selected === "关闭") return;
        if (selected === "查看账户余额（管理 Key）") {
          await account.refresh(ctx.model, () => {}, "openrouterAccount");
          if (epoch !== generation) return;
          await ctx.ui.select(quotaSummary(account.state, account.adapter, ctx.model), ["返回"]);
        } else if (selected === "数据来源与诊断") {
          await ctx.ui.select(quotaDiagnostics(target.adapter, ctx.model), ["返回"]);
        } else await update();
      }
    },
  });
}
