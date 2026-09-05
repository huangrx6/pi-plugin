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

如果文件已存在，合并需要的键即可。也可以先通过菜单或命令选择模式与配置档，再显式保存：

```text
/policy standard
/policy profile auto
/policy save global
```

`save project` 保存到当前目录的 `.pi/policy-engine.json`。保存只更新已选的 mode/profile，不会把合并后的路径或语义服务配置复制到项目。

代理平台的模型别名只在全局配置中声明：

```json
{
  "modelRules": [
    { "provider": "my-proxy", "model": "deepseek-*", "policy": "model.deepseek" }
  ]
}
```

provider/model 取宿主实际标识；`/policy why` 可查看最终适配，`/policy config` 可核对配置来源。辅助语义分类单独配置；只有显式启用后才调用。兼容接口不接受 JSON response_format 或 temperature 时，分别设置 `semanticFallback.jsonResponse: false`、`semanticFallback.temperature: null`。

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

[semantic-primary.json](semantic-primary.json) 是全局配置片段：先替换 endpoint、model 和 apiKeyEnvVar，再合并到全局 config.json。不能放进项目配置。此模式发送当前任务目标、约束、要求及计划上下文，支持 OpenAI 兼容接口；Anthropic 原生接口改为 protocol: `anthropic` 和完整 Messages 地址。

`/policy recognition primary` 切换本次运行，`/policy preview --semantic <请求>` 检查识别来源，`/policy save global` 保存选择。默认仍为离线规则，示例没有真实凭证。

## 直接使用当前 agent 模型

无需使用上述独立接口示例。执行 `/policy recognition agent`，然后 `/policy save global` 即可保存；切换主模型后，下一轮识别跟随切换。认证和平台适配由 Pi 处理。独立接口来源用 `/policy recognition endpoint` 切换。
