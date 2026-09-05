# 配置示例

本目录提供可复制的全局默认和项目规则。先用最小配置运行，再按项目需要加入策略。

## 全局默认

将 [global-policy-engine.json](global-policy-engine.json) 的内容放入 `~/.pi/agent/extensions-data/pi-policy-engine/config.json`：

```json
{
  "mode": "auto",
  "profile": "auto",
  "showStatus": true
}
```

如果文件已存在，合并需要的键即可。日常使用直接执行 `/policy`，在一级面板选择“自动处理”或“谨慎处理”；选择后立即保存，不需要再执行保存命令。

```text
/policy
```

个人选择写入 `~/.pi/agent/extensions-data/pi-policy-engine/config.json`。项目专用路由仍通过当前目录的 `.pi/policy-engine.json` 配置。

代理平台的模型别名只在全局配置中声明：

```json
{
  "modelRules": [
    { "provider": "my-proxy", "model": "deepseek-*", "policy": "model.deepseek" }
  ]
}
```

provider/model 取宿主实际标识；`/policy why` 可查看最终适配，`/policy config` 可核对配置来源。当前 agent 默认在正常回答中结合完整对话理解意图，不需要单独配置模型。

## 项目规则

[project/.pi/policy-engine.json](project/.pi/policy-engine.json) 为后端项目增加领域提示，并明确选择 `compatibility.md` 作为项目策略。

```text
project/.pi/
├── policy-engine.json
└── policies/
    ├── compatibility.md
    └── observability.md
```

将对应配置和策略文件放入目标项目的 `.pi/` 目录。示例中的 `projectPolicies` 是允许列表，因此 `observability.md` 虽然存在，默认不会加载；需要时将其加入列表。

## 核对效果

在目标项目中启动 Pi，先检查配置，再预览任务：

```text
/policy validate
/policy preview 修复后端接口的兼容性问题
```

预览默认使用当前上下文的副本，不联网、不向主模型发送任务，也不推进执行阶段，但会保存预览历史。`preview --new` 从新任务开始；`preview --semantic` 显式允许已经启用的辅助分类服务。实际发送任务后，用 `/policy why` 查看触发依据，用 `/policy injected` 核对注入原文。

在本包目录运行 `npm test` 可以执行规则和扩展测试；示例目录没有独立的测试脚本。

[返回使用说明](../README.md) · [设计说明](../DESIGN.md)

## 大模型优先识别

[recognition-endpoint.json](recognition-endpoint.json) 是全局配置片段：先替换 endpoint、model 和 apiKeyEnvVar，再合并到全局 config.json。不能放进项目配置。此模式发送当前任务目标、约束、要求及计划上下文，支持 OpenAI 兼容接口；Anthropic 原生接口改为 protocol: `anthropic` 和完整 Messages 地址。

把这段配置合并到个人全局 `config.json` 后，可用 `/policy preview --semantic <请求>` 检查识别来源。示例没有真实凭证。

## 直接使用当前 agent 模型

无需使用上述独立接口示例。打开 `/policy` 并选择“自动处理”即可启用和保存；当前 agent 会在正式回答前通过一次独立调用读取有界的近期对话与任务快照，切换主模型后下一轮自动跟随。认证和平台适配由 Pi 处理。
