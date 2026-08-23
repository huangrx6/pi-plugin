// Complete ambient declarations for runtime types.
//
// This file MUST be a script (no top-level `import` / `export`):
//   - Script-mode `declare const process` → global, so consumer `.ts`
//     files see `process.env` without importing.
//   - Script-mode `declare module "X" { ... }` creates a NEW module
//     declaration (not an augmentation). This is what we want here:
//     the real `@earendil-works/pi-coding-agent` is installed at the
//     GLOBAL nvm path (not under this extension's node_modules), so
//     TypeScript can't resolve it from this directory. We declare
//     the module shape ourselves so static checks pass; the runtime
//     uses the real package via jiti + Node's normal resolution.
//
// If you ever add a top-level `export {}` (turning this into a module),
// `declare module` becomes augmentation instead — and TS2307 returns
// because there's nothing to augment against.

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  version: string;
  platform: string;
};

// Loose session-entry shape — covers the patterns the footer renderer
// actually reads. Using `unknown` for nested usage/role keeps things
// permissive (the renderer casts to UsageLike via `as` at read sites).
type LooseSessionEntry = {
  type?: string;
  message?: { role?: string; usage?: unknown };
  usage?: unknown;
};

// Subset of the pi-coding-agent Model shape the renderer accesses.
// All fields optional + the whole object nullable to match the real
// type (pi sets `model = null` between selection and first response).
type ModelLikeShape = {
  id?: string;
  reasoning?: boolean;
  provider?: string;
  contextWindow?: number;
} | null;

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    model: ModelLikeShape;
    thinkingLevel: string | undefined;
    sessionManager: {
      getEntries(): readonly LooseSessionEntry[];
      getCwd(): string;
      getSessionName(): string | null;
    };
    ui: {
      setWidget(key: string, value: unknown): void;
      // Inline renderer signature so the consumer's (tui, theme,
      // footerData) parameters get explicit types (silences TS7006).
      // Shapes mirror types.ts FooterTheme / FooterData but can't
      // reference them (globals.d.ts must stay script-mode to make
      // `declare module` create rather than augment).
      setFooter(
        renderer: (
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string },
          footerData: {
            getGitBranch: () => string | null;
            getExtensionStatuses: () => ReadonlyMap<string, string>;
            getAvailableProviderCount: () => number;
            onBranchChange: (callback: () => void) => () => void;
          },
        ) => unknown,
      ): void;
    };
    getContextUsage?: () =>
      | {
          tokens: number | null;
          contextWindow: number;
          percent: number | null;
        }
      | undefined;
  }

  export interface ExtensionAPI {
    // Explicit `any` (not implicit) on event/ctx — silences TS7006
    // without affecting runtime behavior.
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
  }
}
