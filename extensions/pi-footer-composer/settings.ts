export type PanelId = "stats" | "tokens" | "context" | "more";
export type FooterMode = "custom" | "native";
export type Color = "muted" | "dim" | "text";
export type FooterConfig = {
  $schema?: string;
  version: 5;
  mode: FooterMode;
  icons: "unicode" | "ascii";
  style: { textColor: Color; borderColor: Color; gap: number; panelWidth: number };
  more: { sections: { label: string; status: string; hidden?: boolean }[]; includeUnmapped: boolean };
};
export function defaultFooterConfig(): FooterConfig {
  return {
    version: 5, mode: "custom", icons: "unicode",
    style: { textColor: "muted", borderColor: "dim", gap: 3, panelWidth: 54 },
    more: { sections: [], includeUnmapped: false },
  };
}
// 暂停展示项目和策略。未来恢复时仍通过显式配置接入，不增加专用运行时依赖：
// project: { label: "项目", source: "cwd" }
// policy: { label: "策略", status: "<用户配置的精确 key>", hidden: true }
