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

// Subset of the pi-coding-agent Model shape the refresh logic reads.
// All fields optional + the whole object nullable to match the real
// type (pi sets `model = null` between selection and first response).
type ModelLikeShape = {
  id?: string;
  reasoning?: boolean;
  provider?: string;
  contextWindow?: number;
  baseUrl?: string;
} | null;

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    model: ModelLikeShape;
    hasUI: boolean;
    ui: {
      setStatus(key: string, text: string | undefined): void;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      select(title: string, options: string[]): Promise<string | undefined>;
    };
  }

  export interface ExtensionAPI {
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
    // Explicit `any` (not implicit) on event/ctx — silences TS7006
    // without affecting runtime behavior.
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
  }
}
