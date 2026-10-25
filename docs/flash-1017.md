# Flash 4.1 1017 与桌面端配置

核对日期：2026-10-25。核对宿主：macOS 官方桌面端 DSH 0.2.1-rc.2。

## 模型选择

官方说明：`deepseek-flash` 当前指向 DeepSeek-V4.1-Flash-1017，推荐搭配 DSH 0.2.1-rc.1 或更新版本。因此 0.2.1-rc.2 符合该版本建议；无需把模型 ID 改成显示名称或自行拼接 `-1017`。[模型更新记录](https://api-docs.deepseek.com/updates/)、[1017 发布说明](https://api-docs.deepseek.com/news/news261017/)。

在桌面端模型设置中使用以下组合；已有相同配置时无需修改：

| 设置 | 值 |
| --- | --- |
| Provider | `deepseek-official` |
| Model ID | `deepseek-flash` |
| 推理强度 | `max`（保留当前选择） |

模型别名会随官方更新变化，以上不是对未来版本的快照锁定，也不是对某次服务端响应权重的独立验证。

## 实际请求格式

检查 0.2.1-rc.2 宿主源码可知，`deepseek-official` 使用 Anthropic Messages 格式。默认请求地址为 `https://api.deepseek.com/anthropic/v1/messages`；工具定义通过 `input_schema` 传递。官方兼容接口支持该格式的流式输出、工具调用和工具结果。[Anthropic 兼容接口说明](https://api-docs.deepseek.com/guides/anthropic_api/)。

宿主把 `reasoningEffort: max` 转成 `thinking: { type: "enabled" }` 与 `output_config: { effort: "max" }`。宿主接受的推理选项是 `off`、`low`、`high`、`max`；关闭思考时使用 `off`。无需向桌面配置添加 Chat Completions 的 `reasoning_effort` 字段。本轮修复不改变推理强度、Provider 或模型 ID。

## 本分支修复的行为

- **启动阶段的输出预算**：锚点门只收紧上限。预设默认 `bootstrapMaxTokens: 8192`，调用方设置 2048 时仍为 2048；设置 16384 时启动阶段为 8192。首轮晋级后使用调用方原始预算，包括恰好为 8192 的预算。同一会话中切换模型或 Provider 仍能解除插件施加的临时上限，同时保留新选择的路由与推理强度；新 agent 或显式修改预算时不会恢复过期值。压缩上下文后重新进入启动阶段。
- **预设设置保留**：普通非强制同步更新锚点脚本，保留已有锚点配置；缺少锚点行时才补齐。显式强制安装仍会整体恢复模板；已有的失效预设组合重装机制也不在本轮改动范围内。
- **工具注册**：证据记录、验证、升级工具中的五个开放对象字段补齐 `additionalProperties: true`，满足 DSH 0.2.1 的参数编译要求，同时继续允许任意嵌套 JSON 证据。

需要调整启动阶段预算时，可在自己的 `redteam` 预设中修改 `anchor-gate.config.bootstrapMaxTokens`。这是该预设的临时输出上限，不是模型上下文窗口，也不会自动改变模型推理强度。普通模式不经过这个锚点门。

## 验证范围

仓库回归测试使用 `npm test`，覆盖预算、晋级/压缩、用户配置保留、强制重置、缺行修复和工具注册。所有预设写入测试都使用独立的临时用户目录和 DSH_HOME。

另外使用从上述桌面安装包提取的宿主函数做离线协议校验；未启动桌面应用、未启用插件、未读取 API 密钥，也未发出真实模型请求。因此这里证明的是源码与离线协议兼容性，不是实际联网对话、模型效果或全部补丁的运行验证。修改位于 fork 的评审分支；不会自动更新已安装的插件。
