export type FooterMode = "compact" | "overview" | "native";
export const BUILTIN_FIELDS = ["project", "cwd", "branch", "session", "model", "provider", "thinking", "context", "cacheHit", "input", "output", "cacheRead", "cacheWrite", "cost"] as const;
export type Field =
  | string
  | { source: string; prefix?: string; suffix?: string; empty?: string }
  | { status: string; prefix?: string; suffix?: string; empty?: string };
export type CellConfig = { label: string; fields: Field[]; hidden?: boolean };
export type ViewConfig = {
  renderer: "table" | "bands";
  showLabels: boolean;
  style?: Partial<StyleConfig>;
  rows: (CellConfig | null)[][];
};
export type StyleConfig = {
  textColor: "muted" | "dim" | "text";
  borderColor: "muted" | "dim" | "text";
  borders: "all" | "outer" | "none";
  labelDivider: boolean;
  labelWidth: number;
  columnGap: number;
  fieldGap: number;
  leftRatio: number;
  narrowWidth: number;
  overflow: "wrap" | "ellipsis";
  maxCellLines: number;
};
export type FooterConfig = {
  $schema?: string;
  mode: FooterMode;
  style: StyleConfig;
  views: { compact: ViewConfig; overview: ViewConfig };
};
export const DEFAULT_FOOTER_CONFIG: FooterConfig = {
  mode: "compact",
  style: {
    textColor: "muted", borderColor: "dim", borders: "all", labelDivider: true,
    labelWidth: 4, columnGap: 3, fieldGap: 3, leftRatio: 0.5, narrowWidth: 72,
    overflow: "wrap", maxCellLines: 0,
  },
  views: {
    compact: { renderer: "table", showLabels: true, rows: [
      [{ label: "项目", fields: ["project", "branch"] }, { label: "模型", fields: ["model", "provider", "thinking"] }],
      [{ label: "资源", fields: ["context", "cacheHit", "input", "output", "cacheRead", "cacheWrite", "cost"] }, { label: "状态", fields: ["remaining"] }],
    ] },
    overview: { renderer: "bands", showLabels: true, style: { borders: "outer", labelDivider: false }, rows: [
      [{ label: "项目", fields: ["project", "branch"] }, { label: "模型", fields: ["model", "provider", "thinking"] }],
      [{ label: "资源", fields: ["context", "cacheHit", "input", "output", "cacheRead", "cacheWrite", "cost"] }, { label: "状态", fields: ["remaining"] }],
    ] },
  },
};
export function defaultFooterConfig(): FooterConfig { return structuredClone(DEFAULT_FOOTER_CONFIG); }
