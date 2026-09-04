<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/quota-status.svg" alt="pi-quota-status" width="48" />
</p>

# pi-quota-status

<p align="center"><strong>查看 AI 服务的套餐用量、账户余额与密钥额度。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

输入 `/quota` 打开独立详情面板并刷新数据；原生状态栏只提供简短摘要。主视图只展示当前额度、更新时间与当前错误；接口、凭证变量、完整适配范围与验证边界放在「数据来源与诊断」次级视图。使用 Pi 原生选择器与当前终端主题，不写固定 ANSI 配色，不按模型名称推测计费平台。

## 入口与操作

| 入口 | 行为 |
| --- | --- |
| `/quota` | 查询当前 provider 对应的环境凭证，打开详情面板 |
| 面板中的「刷新」 | 重新查询，显示更新时间与失败原因 |
| `/quota refresh` | 直接刷新并打开详情 |
| `/quota sources` | 查看接口、凭证变量、适配范围与验证边界 |
| `/quota account` | 单独查询 OpenRouter 管理 Key 所属账户的余额 |

```text
额度 / DeepSeek API
账户余额

  余额  ¥42.30

更新于 14:32:10

> 刷新
  数据来源与诊断
  关闭
```

套餐窗口使用 10 格文字仪表，同时保留已用文字与精确百分比；金额与状态不套用百分比颜色。RPC、JSON 与 print 模式不打开终端对话框，只返回纯文本摘要。

显示的是所列环境变量对应的账户。扩展不读取或执行 `auth.json` 中的凭证，也不自动确认环境 Key 与当前推理凭证属于同一账户；多账号使用时请保持两者一致。

## 适配范围

| Provider 名称 | 产品与口径 | 环境变量 |
| --- | --- | --- |
| `opencode-go` | OpenCode Go：5 小时 / 周 / 月已用比例 | `OPENCODE_API_KEY` |
| `zai-coding-cn` | 国内 GLM Coding Plan：已识别窗口的已用比例 | `ZAI_CODING_CN_API_KEY`（兼容 `ZAI_API_KEY`） |
| `minimax-cn` / `minimax` / `cc-switch-mini-max` | 国内 MiniMax Token Plan：已用比例 | `MINIMAX_CN_API_KEY`（兼容 `MINIMAX_API_KEY`） |
| `kimi` / `kimi-code` / `kimi-coding` | Kimi Code：5 小时窗口与总套餐已用比例 | `KIMI_API_KEY` |
| `moonshot` / `moonshot-cn` / `kimi-api` | 国内 Kimi API：可用余额（人民币） | `MOONSHOT_API_KEY` |
| `siliconflow` / `siliconflow-cn` | 国内 SiliconFlow：账户总余额（人民币） | `SILICONFLOW_API_KEY` |
| `deepseek` / `deepseek-cn` | DeepSeek API：按响应中的 CNY / USD 分别显示余额 | `DEEPSEEK_API_KEY` |
| `openrouter` | 当前环境 Key 的剩余消费上限（美元） | `OPENROUTER_API_KEY` |
| `/quota account` 独立入口 | OpenRouter 管理 Key 所属账户剩余余额（美元） | `OPENROUTER_MANAGEMENT_KEY` |

只有已适配的官方地区端点会自动查询；国际站或代理端点会明确说明「当前端点未适配」，不会悄悄查询另一地区账户。迁移注意：`moonshot` 现在查询 Kimi API 余额（Kimi Code 用户改用 `kimi-code` 等）；`opencode` 不再自动映射 Go 套餐；MiniMax 必须配置国内 Token Plan 专用 Key；Kimi 总窗口没有窗口元数据时不固定标「一周」；OpenRouter 显示「Key 剩余」，未设上限不等于账户余额无限。

## 数据含义与验证边界

| 数据 | 显示规则 |
| --- | --- |
| 套餐百分比 | 统一显示已用比例；MiniMax 的剩余比例先反转 |
| 金额或百分比为 `null` | 显示 `--`，不转成 0 |
| 错误类型、非数字、非有限数字 | 拒绝计算并显示查询失败 |
| 重置时间缺失或无法识别 | 省略倒计时，不显示「已重置」 |
| DeepSeek `is_available=false` | 保留实际余额，另外显示「不可调用」 |
| 临时网络失败 | 最多保留 60 秒内的成功值并立即标记 `?` |
| 认证失败、切换服务 / 地区 / 凭证 | 清除旧值；旧请求不能回写新状态 |

适配器有响应校验与离线 fixture 测试，新增接口依据官方契约实现，**尚未用真实账号与账单控制台逐项对账**；接口成功响应不能代替这一步。已有查询接口也可能随产品策略变化，错误与未知值会明确显示。

- [Kimi API 查询余额](https://platform.kimi.com/docs/api/balance) · [SiliconFlow OpenAPI](https://github.com/siliconflow/siliconcloud/blob/main/openapi.yaml) · [DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance/)
- [OpenRouter Key 限制](https://openrouter.ai/docs/api/reference/limits) · [OpenRouter 账户余额](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) · [MiniMax Token Plan FAQ](https://platform.minimaxi.com/docs/token-plan/faq)

本版本不把 OpenAI / Claude 的历史 API 用量折算为订阅剩余比例，也不使用网页 Cookie 抓取订阅；无可靠契约的产品不显示猜测值。

## 刷新与生命周期

启动、切换模型和切换分支后刷新；回合结束最多每 10 秒一次，面板手动刷新不受限。没有后台轮询计时器。每个扩展实例独立持有缓存；请求在切换、缺 Key、未适配 provider 和会话关闭时先失效并取消，并以序号阻止不响应取消的旧请求覆盖新数据——缓存身份包含 provider、模型端点、查询端点与凭证摘要。

## 安装与开发

```bash
pi install git:github.com/huangrx6/pi-plugin
```

配置所需环境变量后重启 Pi；修改代码后 `/reload`。凭证只从环境读取，不写入磁盘、不显示值——诊断页只显示环境变量名。请求只发向固定官方端点，禁止自动跟随重定向。

```bash
cd extensions/pi-quota-status
npm run check && npm test    # 格式 oracle：时长 / 颜色带 / 条形分支 / 空态
```

测试使用虚构凭证与本地响应替身，覆盖成功、未知值、异常响应、凭证与服务切换、关闭后晚到响应及独立命令刷新，不访问真实账户。

<details>
<summary>文件结构</summary>

```text
pi-quota-status/
├── index.ts          # Pi 事件、独立命令与原生状态摘要
├── monitor.ts        # 请求取消、缓存隔离、错误与生命周期
├── adapters.ts       # 固定接口、产品映射、响应处理
├── parse.ts          # 外部对象 / 数字 / 百分比 / 时间校验
├── panel.ts          # 分层面板文本
├── format.ts         # 紧凑状态格式
├── ui.ts             # 控制字符清理与显示宽度处理
├── state.ts / types.ts / constants.ts
└── tests/            # 格式 oracle 测试
```

</details>

## License

MIT © huangrx6
