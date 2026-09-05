<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-browser-test</h1>

<p align="center">先冻结可审计的业务测试语义，再进入浏览器规划与执行。</p>

`pi-browser-test` 当前实现 Test Spec Schema v1.0 的验证层。它检查测试身份、固定资产、前置条件、Capability Contract 引用、输入、业务断言和清理语义，并生成稳定的 `TestSpecHash`。

本版本不点击页面，也不生成 locator 或 Playwright 脚本。通过验证只说明 Test Spec 结构和业务引用有效，不代表任何动作获得授权或已经执行。

## 快速开始

在扩展目录安装并重新加载 Pi：

```bash
pi install "$PWD"
```

准备 Test Spec 和 Capability Registry 后运行：

```text
/browser-test validate path/to/case.test-spec.json --registry path/to/capability-registry.json
```

省略 `--registry` 时读取当前项目的：

```text
.pi/browser-test/capability-registry.json
```

只获取规范化哈希：

```text
/browser-test hash path/to/case.test-spec.json --registry path/to/capability-registry.json
```

路径包含空格时使用单引号或双引号。

## Test Spec 边界

Test Spec 表达长期稳定的业务测试语义：

```text
identity → intent → actors → fixtures → preconditions
         → setup → steps → assertions → cleanup
```

以下内容不属于 Test Spec：浏览器和环境、URL、locator、Resolver、Action Plan、运行状态、任意代码、Secret、风险降级或授权结论。实现层变化不改变 Test Spec；业务语义变化必须产生新的 `testSpecId` 和递增的 `revision`，`caseId` 保持稳定。

完整冻结规则见 [`SPEC.md`](SPEC.md)，正式 JSON Schema 位于 [`schema/test-spec.schema.json`](schema/test-spec.schema.json)。扩展使用无运行时第三方依赖的结构校验器实现同一份封闭模型，再执行独立语义校验。合法 Cleanup 的 `when` 字段已作为 Cleanup 自身属性定义，避免 `allOf` 与 `additionalProperties: false` 组合导致的错误拒绝。

## 两层验证

第一层验证 JSON Schema 能表达的结构约束：必填字段、封闭对象、稳定 ID、枚举、长度、JSON Pointer、ISO-8601 Duration 和 ValueExpression 的互斥分支。

第二层验证跨对象语义：

| 规则 | 检查内容 |
| --- | --- |
| TS-001～TS-004 | ID 唯一、Actor/Fixture 引用存在、Step Output 不向未来引用 |
| TS-005～TS-007 | Contract 版本存在、输入类型兼容、Output Path 存在 |
| TS-008～TS-009 | Predicate 与来源类型兼容、`expected` 必需性正确 |
| TS-010～TS-012 | Cleanup 无豁免；动作与查询种类匹配；Probe 无副作用 |
| TS-013～TS-015 | 拒绝实现绑定、风险自降级字段和 Secret |
| FIXTURE-001～003 | Fixture 路径受限于规范目录、文件可读、SHA-256 与声明一致 |

错误采用稳定代码与 JSON Pointer 路径，例如：

```text
× TS-007 /steps/1/input/documentId/stepOutputRef/path — output path does not exist
```

## Capability Registry

Registry 是验证时输入，不嵌入 Test Spec。每个 Contract 至少包含：

```json
{
  "capabilityId": "cap_document_status",
  "contractVersionId": "capcontract_document_status_1_0",
  "kind": "QUERY",
  "sideEffect": "NONE",
  "externalEffect": "NONE",
  "inputSchema": {
    "type": "object",
    "required": ["documentId"],
    "additionalProperties": false,
    "properties": {
      "documentId": { "type": "string" }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "string" }
    }
  }
}
```

文件或二进制输入可使用受控扩展关键字：

```json
{ "x-pi-valueKind": "FILE" }
```

v0.1.0 的 Capability Schema 使用明确的最小子集：`type`、`properties`、`required`、`items`、`additionalProperties`、`enum`、`const` 和 `x-pi-valueKind`。出现未实现的 Schema 关键字会直接报告 Registry 错误，不会静默忽略后误判为通过。

Assertion 与 Precondition Probe 必须引用 `QUERY`，并同时满足 `sideEffect=NONE`、`externalEffect=NONE`。

## Canonicalization 与哈希

对象键按字典序排列。`actors`、`fixtures`、`preconditions` 按稳定 ID 排列，`tags` 按文本排列；这些集合的源文件顺序不影响哈希。`setup`、`steps`、`assertions`、`cleanup` 保持原顺序，因为顺序属于业务语义。只有结构、语义与 Fixture 完整性全部通过时才输出 `TestSpecHash`。

可运行样例位于 [`examples/document-upload.test-spec.json`](examples/document-upload.test-spec.json)，对应 Registry 位于 [`examples/capability-registry.json`](examples/capability-registry.json)。

## 开发验证

```bash
npm ci
npm run check
npm test
```

## License

[MIT](LICENSE) © Huangrx6
