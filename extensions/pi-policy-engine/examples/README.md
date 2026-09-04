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

如果文件已存在，合并需要的键即可。

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

预览不向主模型发送任务，也不推进执行阶段，但会保存预览历史。实际发送任务后，用 `/policy why` 查看触发依据，用 `/policy injected` 核对注入原文。

在本包目录运行 `npm test` 可以执行规则和扩展测试；示例目录没有独立的测试脚本。

[返回使用说明](../README.md) · [设计说明](../DESIGN.md)
