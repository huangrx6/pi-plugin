// pi-ambient.d.ts — 仓库根 pi 运行时类型的共享 ambient shim (0.41.0+)
//
// 合并自 8 个 TS 扩展各自的 globals.d.ts (P1.3)。`declare module "X"`
// 在 script-mode 下创建新模块声明，所以本文件必须保持 script-mode
// （无 top-level import / export）。
//
// 设计原则：松而广。各扩展在代码里用本地 `interface XxxShape` 做窄化
// (例如 pi-todo 的 LooseBranchEntry、pi-mode-switcher 的
// ModeSwitcherToolCallEvent)，shared shim 故意不定义这些窄类型——
// TypeScript interface 声明合并在 script-mode 下会跨文件冲突。
//
// 维护时：扩展需要新增 pi API 字段时，只改本文件；不要回退到
// 各扩展的独立 globals.d.ts。

// ────────────────────────────────────────────────────────────────────
// pi 运行时类型
// ────────────────────────────────────────────────────────────────────

declare module "@earendil-works/pi-coding-agent" {
  // ExtensionAPI：仓库内最宽用法。
  // 多数扩展只用 on / registerCommand，所以这两个是显式类型；
  // 其余方法（registerTool / sendMessage / appendEntry / 等）以
  // 宽松签名覆盖（参数 any、返回 unknown），交给各扩展在 index.ts
  // 入口用本地 interface 窄化。test fake pi 用 `as ExtensionAPI`
  // 兑底（见 pi-notify/index.test.ts 现有约定）。
  export interface ExtensionAPI {
    /** 注册 pi 事件 hook。 */
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    /** 注册斜杠命令。 */
    registerCommand(
      name: string,
      definition: {
        description: string;
        handler: (args: string, ctx: any) => Promise<void> | void;
      },
    ): void;
    /** 注册工具（pi 0.85 组件契约；renderCall/renderResult 在
     *  各扩展本地 interface 细化）。 */
    registerTool(definition: {
      name: string;
      label?: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal: AbortSignal,
        onUpdate: ((chunk: unknown) => void) | undefined,
        ctx: any,
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
      renderCall?: (args: any, theme: any, context: any) => unknown;
      renderResult?: (result: any, options: any, theme: any, context: any) => unknown;
    }): void;
    /** 注册自定义 entry 渲染器（用于 session 内 custom entry 在
     *  TUI 的卡片化展示）。 */
    registerEntryRenderer<T>(
      type: string,
      renderer: (
        entry: { data?: T },
        options: { expanded: boolean },
        theme: any,
      ) => { render(width: number): string[]; invalidate(): void } | undefined,
    ): void;
    /** 注册自定义 message 渲染器（自定义 message 在 TUI 的卡片化）。 */
    registerMessageRenderer(
      type: string,
      factory: (message: any, options: any, theme: any) => unknown,
    ): void;
    /** 注册 markdown transformer。 */
    registerMarkdownTransformer(
      transformer: (
        markdown: string,
        ctx: { messageType: "user" | "assistant" | "assistant-thinking"; isStreaming: boolean; availableWidth?: number },
      ) => string,
    ): void;
    /** 写一条 session entry（不进入 LLM context，但可见于 /loaded-skills
     *  等会话内历史视图）。 */
    appendEntry(customType: string, data?: unknown): void;
    /** 注入一条自定义消息（进 LLM context + TUI 渲染）。可选触发轮次。 */
    sendMessage(
      message: { customType: string; content: string; display: boolean },
      options: { triggerTurn?: boolean; deliverAs: "followUp" | "steer" | "nextTurn" },
    ): void;
    /** 取已注册命令列表（pi 0.85 新 API）。 */
    getCommands?(): unknown[];
    /** 取所有工具元数据（pi 0.85 新 API）。 */
    getAllTools?(): unknown[];
    /** 取当前活跃工具列表。 */
    getActiveTools?(): string[];
    /** 设置活跃工具。 */
    setActiveTools?(names: string[]): void;
    /** 注册快捷键。 */
    registerShortcut?(id: string, options: { description: string; handler: (ctx: any) => void }): void;
    /** 注册 CLI flag。 */
    registerFlag?(name: string, options: { description: string; type?: "boolean" | "string"; default?: unknown }): void;
  }

  // ExtensionContext：仓库内最宽用法。同 ExtensionAPI 原则，宽松。
  // 各扩展在 handler 内用本地 `ctx as XxxCtx` 窄化。
  export interface ExtensionContext {
    /** 当前工作目录。 */
    cwd: string;
    /** 当前模型（pi 0.85+：null 在未选模型 / 已选未响应窗口期）。 */
    model: { id?: string; provider?: string; reasoning?: boolean; contextWindow?: number; baseUrl?: string } | null;
    /** thinking 等级。 */
    thinkingLevel: string | undefined;
    /** 输出模式。 */
    mode: "tui" | "rpc" | "json" | "print";
    /** UI 是否可用（false 表示 RPC / json 模式）。 */
    hasUI: boolean;
    /** 上下文用量（pi 0.85+）。 */
    getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    /** session 是否空闲（pi 0.85+）。 */
    isIdle?(): boolean;
    /** session 是否有 pending 消息。 */
    hasPendingMessages?(): boolean;
    /** session 入口。 */
    sessionManager: {
      getSessionId?(): string;
      getSessionName?(): string | null;
      getBranch?(): Iterable<unknown>;
      getEntries?(): readonly unknown[];
      getCwd?(): string;
    };
    /** UI 入口。 */
    ui: {
      notify(message: string, level?: string): void;
      setStatus(key: string, text: string | undefined): void;
      setWidget?(key: string, value: unknown, options?: { placement?: string }): void;
      setFooter?(renderer: ((tui: any, theme: any, footerData: any) => unknown) | undefined): void;
      select(title: string, options: string[]): Promise<string | undefined>;
      confirm(title: string, message: string): Promise<boolean>;
      input?(title: string, placeholder?: string, options?: unknown): Promise<string | undefined>;
      editor?(title: string, prefilled?: string): Promise<string | undefined>;
      custom?(factory: (tui: any, theme: any, keybindings: any, done: (value: any) => void) => unknown, options?: unknown): Promise<any>;
      addAutocompleteProvider?(provider: unknown): void;
      pasteToEditor?(text: string): void;
      getEditorText?(): string;
      setEditorText?(text: string): void;
    };
  }

  // Entry 渲染选项（renderCall / renderResult / renderEntryRenderer
  // 共用的 { expanded } 字段）。
  export interface RenderOptions {
    expanded: boolean;
  }

  // 默认导出：扩展入口签名。
  export type ExtensionEntry = (pi: ExtensionAPI) => void;

  // 值导出：项目本地配置目录名（pi 0.85 暴露的全局常量）。
  export const CONFIG_DIR_NAME: string;

  /** 加载后注入到 LLM context 的 skill 块（pi 0.85 内置 ParsedSkillBlock）。 */
  export type ParsedSkillBlock = {
    name?: string;
    path?: string;
    location: string;
    content: string;
    [key: string]: unknown;
  };
}

// ────────────────────────────────────────────────────────────────────
// 全局类型（不藏在 declare module 内，供 pi-todo 等扩展直接访问）
// ────────────────────────────────────────────────────────────────────

/**
 * 工具渲染器 Component 契约（pi 0.85+）。
 * ToolExecutionComponent 在 mouse click-to-expand 时会调用
 * child.invalidate()——所以 renderCall / renderResult 必须
 * 返回的 renderable 带有 invalidate() 方法，不能是裸 string。
 */
type ToolRenderComponent = {
  render(width: number): string[];
  invalidate(): void;
};

// ────────────────────────────────────────────────────────────────────
// pi-tui 组件（pi-skill-inject 使用 Box/Text 构造器）
// ────────────────────────────────────────────────────────────────────

declare module "@earendil-works/pi-tui" {
  // 故意宽松：real pi-tui 有更细的构造器签名，但仓库内只用到
  // new Box(...)/new Text(...) + addChild。后续 pi-tui API 演进
  // 不会让 strict 形态挡住。
  export class Box {
    constructor(...args: unknown[]);
    addChild(child: unknown): void;
  }
  export class Text {
    constructor(...args: unknown[]);
  }
}
