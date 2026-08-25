# Examples

可复制粘贴试用的最小配置。

## `project/` — 后端项目的典型配置

```text
examples/project/
├── .pi/
│   ├── policy-engine.json
│   └── policies/
│       ├── compatibility.md    # API 兼容、schema 迁移、集成测试契约
│       └── observability.md    # 日志字段、错误传播、metric 标签
```

试用方式：

```bash
# 把 examples/project/.pi 复制到你项目的根目录
cp -R examples/project/.pi /path/to/your-project/

# 在 /path/to/your-project 启动 pi
cd /path/to/your-project
pi
```

然后发 prompt：

- 改一句 typo → 自动 `quick`
- 修一个普通 bug → 自动 `standard`
- 「设计生产环境 PG schema 迁移方案」→ 自动 `strict` + 等你批准

发完后跑 `/policy why` 看命中规则。

## `global-policy-engine.json` — 用户全局默认

最小可用配置，复用 package defaults：

```json
{
  "mode": "auto",
  "profile": "auto"
}
```

放到 `~/.pi/agent/policy-engine.json`。

## 怎么验证 examples 生效

```bash
# 在 examples/project/ 下跑 self-test 模拟一次决策
node ../scripts/self-test.mjs
```

## 加自己的示例

PR 时把项目专用配置放进 `examples/<your-case>/.pi/`，最好附一个 `README.md` 说明触发场景。
