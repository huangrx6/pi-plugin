<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-quota-status</h1>

<p align="center">在 Pi 中查看套餐用量、账户余额与 API Key 额度。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

额度按服务和地区识别，按实际计费口径展示。输入 `/quota` 即可刷新并查看详情；日常状态保持简短，接口与凭证信息放在次级诊断页。

## 快速开始

在本扩展包目录中执行，单独安装此扩展：

```bash
pi install "$PWD"
```

在启动 Pi 的环境中配置对应服务的 Key，重启 Pi 后输入 `/quota`。只需配置正在使用的服务，完整支持范围见下文。

**账户对应关系由使用者确认。** 查询使用环境变量中的凭证，不读取或执行 `auth.json` 的凭证。环境 Key 与当前推理 Key 可能属于不同账户；诊断页只显示变量名，不显示 Key 内容。

## 日常使用

主视图展示当前额度、更新时间和查询错误。套餐窗口以十格仪表和「已用百分比」呈现，余额保留币种与金额。界面使用 Pi 原生选择器与当前主题，原生状态栏提供摘要。

| 操作 | 结果 |
| --- | --- |
| `/quota` | 刷新当前服务，打开额度面板 |
| `/quota refresh` | 与默认入口相同，显式执行刷新 |
| `/quota sources` | 查看数据来源、凭证变量与适配说明 |
| `/quota account` | 单独查询 OpenRouter 管理 Key 所属账户余额 |

面板内可以刷新、进入「数据来源与诊断」或关闭。当前服务为 OpenRouter 时，还可进入管理账户余额视图。RPC、JSON 与 print 模式使用文本摘要，不打开终端选择器。

## 支持的服务

三类数据分别展示，不能互相替代：**套餐用量**反映窗口消耗，**账户余额**反映可用金额，**Key 额度**反映单个密钥的消费限制。

| 服务 | 展示口径 | 首选环境变量 |
| --- | --- | --- |
| OpenCode Go | 5 小时、周、月已用比例 | `OPENCODE_API_KEY` |
| 国内 GLM Coding Plan | 已识别窗口的已用比例 | `ZAI_CODING_CN_API_KEY` |
| 国内 MiniMax Token Plan | 套餐已用比例 | `MINIMAX_CN_API_KEY` |
| Kimi Code | 5 小时窗口与总套餐已用比例 | `KIMI_API_KEY` |
| 国内 Kimi API | 人民币可用余额，含现金与代金券 | `MOONSHOT_API_KEY` |
| 国内 SiliconFlow | 人民币账户总余额，含赠送与充值 | `SILICONFLOW_API_KEY` |
| DeepSeek API | 按响应币种分别显示余额及可调用状态 | `DEEPSEEK_API_KEY` |
| OpenRouter Key | 美元剩余消费上限 | `OPENROUTER_API_KEY` |
| OpenRouter 账户 | 管理 Key 所属账户的美元余额 | `OPENROUTER_MANAGEMENT_KEY` |

<details>
<summary>Provider 名称、凭证别名与地区限制</summary>

| 适配器 | 接受的 Provider 名称 | 已适配的模型端点主机 |
| --- | --- | --- |
| OpenCode Go | `opencode-go` | `opencode.ai` |
| GLM Coding Plan | `zai-coding-cn` | `open.bigmodel.cn` |
| MiniMax Token Plan | `minimax-cn`、`minimax`、`cc-switch-mini-max` | `api.minimaxi.com`、`www.minimaxi.com` |
| Kimi Code | `kimi`、`kimi-code`、`kimi-coding` | `api.kimi.com` |
| Kimi API | `moonshot`、`moonshot-cn`、`kimi-api` | `api.moonshot.cn` |
| SiliconFlow | `siliconflow`、`siliconflow-cn` | `api.siliconflow.cn` |
| DeepSeek | `deepseek`、`deepseek-cn` | `api.deepseek.com` |
| OpenRouter | `openrouter` | `openrouter.ai` |

GLM 兼容 `ZAI_API_KEY`，MiniMax 兼容 `MINIMAX_API_KEY`，首选变量优先。MiniMax 必须使用国内 Token Plan 专用 Key。

自动查询同时核对 Provider 和已提供的模型端点：端点必须使用 HTTPS，并匹配表中的主机；未提供端点时按 Provider 识别。国际站、代理和未知主机不自动映射为另一地区账户。`/quota account` 是独立查询入口，不要求当前模型为 OpenRouter。

`moonshot` 表示 Kimi API 余额；Kimi Code 使用 `kimi-code` 等名称。`opencode` 不映射 Go 套餐。Kimi 总套餐窗口缺少元数据时只标为套餐，不推测固定一周。OpenRouter Key 未设置上限不表示账户余额无限。

</details>

## 数据可信度

| 情况 | 显示与处理 |
| --- | --- |
| 金额或百分比为 `null` | 显示 `--`，不按 0 计算 |
| 数据类型错误或非有限数字 | 拒绝计算，显示查询失败 |
| 重置时间缺失或无法识别 | 省略倒计时 |
| DeepSeek `is_available=false` | 保留实际余额，单独显示不可调用 |
| 暂时性网络或服务错误 | 失败时仅保留最近 60 秒内取得的成功值，并标记刷新失败 |
| 认证失败或服务、地区、凭证变化 | 清除旧值，阻止旧请求覆盖当前状态 |

没有后台定时器，成功值不会在 60 秒时自动清除；详情页会按数据年龄提示过期，后续刷新重新判断是否保留。启动、切换模型和切换会话分支时刷新；回合结束的查询间隔至少 10 秒，手动刷新不受此限制。单次请求超时为 15 秒。

请求只发往固定官方查询端点，不跟随重定向。无需独立配置文件或数据目录：凭证来自环境变量，缓存仅保存在当前扩展实例内，以服务、模型端点、查询端点和凭证摘要隔离；切换或关闭会话时取消请求并使晚到响应失效。

**适配器已做响应校验和离线测试，尚未使用真实账户与账单控制台逐项对账。** 本扩展不将 OpenAI 或 Claude 的历史 API 用量换算为订阅剩余比例，也不通过网页 Cookie 抓取订阅数据。

<details>
<summary>官方接口与资料</summary>

- [Kimi API 余额接口](https://platform.kimi.com/docs/api/balance)
- [SiliconFlow OpenAPI](https://github.com/siliconflow/siliconcloud/blob/main/openapi.yaml)
- [DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance/)
- [OpenRouter Key 限制](https://openrouter.ai/docs/api/reference/limits)
- [OpenRouter 账户余额](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [MiniMax Token Plan FAQ](https://platform.minimaxi.com/docs/token-plan/faq)

各适配器当前使用的精确端点可在 `/quota sources` 或 [adapters.ts](adapters.ts) 中核对。

</details>

## 开发

在本扩展目录中执行：

```bash
npm ci
npm run check
npm test
```

包声明 Node.js `>=20`；实际运行还需满足所用 Pi 版本的要求。测试使用虚构凭证和响应替身，不访问真实账户，覆盖数据校验、格式、菜单、请求取消、凭证切换与晚到响应。修改代码后在 Pi 中执行 `/reload`。

[变更记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
