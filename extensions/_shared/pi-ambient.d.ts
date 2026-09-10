// pi-ambient.d.ts — 仓库根 pi 运行时类型的共享 ambient 占位(0.41.0 / 0.42.0+)
//
// 历史背景：仓库内 8 个 TS 扩展各持一份 @earendil-works/pi-coding-agent
// 的 ambient shim（每个 extensions/pi-*/globals.d.ts）。pi 升级 API 时
// 8 份同步成本指数增长；P1.3 计划把它们合并到本文件。
//
// 当前（本骨架阶段）：仅占位声明，实际 shim 内容仍在各自 globals.d.ts
// 中；P1.3 完成真实单源化后，会把每份 globals.d.ts 的内容并入此处
// 的 declare module "@earendil-works/pi-coding-agent" { ... } 块里，
// 然后删除各扩展的 globals.d.ts。
//
// 此文件不 import / export 任何东西，保持 script-mode 以兼容
// `declare module "X" { ... }` 创建新模块声明的语义。

declare module "@earendil-works/pi-coding-agent" {
  // 内容由 P1.3 合并入；P0.2 阶段保留为空声明作为扩展点。
}
