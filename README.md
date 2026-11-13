# dsh-subagent-opencode

使用已有 OpenCode CLI 的 DeepSeek Harness 子代理插件。目标 Harness 接口和依赖版本为 **0.2.2-rc.3**。

沿用官方 `@deepseek-ai/dsh-subagent-codex@0.2.2-rc.3` 的 Provider、一次性运行、共享进程管理和 Bundle 结构，产品协议替换为 OpenCode ACP。

## 安装和升级

在 DeepSeek Harness 插件管理中安装 **`dsh-subagent-opencode-0.1.2.tgz`**，确认已安装版本为 **0.1.2**，然后按 Harness 提示重载或重启。

仅生成或下载 tgz 不会更新已安装插件。安装新包后，新的失败诊断应包含 `plugin: 0.1.2`；如果仍只显示 `product: OpenCode; stage: prompt; category: product-error`，请检查是否仍加载旧包。本交付不会自动安装或启动 OpenCode。

Bundle 注册 Provider `opencode` 和全局工具 `subagent_opencode`，委派工具使用官方 `@deepseek-ai/dsh-tool-subagent`。无自动安装脚本，不捆绑、下载或安装 OpenCode，不查询 CLI 版本。

附带配置指向当前已有 CLI：

```text
E:\nodejs\node_global\node_modules\@opencode\cli\bin\opencode.exe
```

如果移动 CLI，修改插件的 `command`。该字段接受单个可执行文件或 Node 脚本路径，不接受 shell 命令。

## 权限和配置

插件固定使用 `full-access`，仅向本次子进程注入 `OPENCODE_CONFIG_CONTENT`，追加全允许规则，并给所选 agent 追加相同规则。ACP 权限请求自动选择允许选项，优先 `allow_once`，每次请求都自动批准。沿用当前操作系统用户权限，不修改原生登录和磁盘配置。

OpenCode 自行读取原生配置、认证和 MCP。Harness 会清理父进程环境中的部分变量，需要明确传给子进程的凭据可配置在 `env`；原生磁盘认证仍由 OpenCode 管理。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `providerName` | `opencode` | Harness Provider 注册名 |
| `command` | `opencode` | 已有 CLI；附带 Bundle 指定上方绝对路径 |
| `model` | 不设置 | 可选的 `provider/model` 路由，通过 ACP 会话配置设置 |
| `agent` | `build` | 原生主 agent 和权限覆盖目标 |
| `permissionMode` | `full-access` | 此构建唯一支持的权限模式 |
| `env` | `{}` | 显式子进程环境变量 |
| `disposeGraceMs` | `3000` | 会话清理和受管进程终止宽限，不是任务时限 |
| `deleteSession` | `true` | ACP 支持时删除本次创建的原生会话 |

`env.OPENCODE_CONFIG_CONTENT` 必须是 JSON 对象，原有字段会保留，再叠加本次权限设置。磁盘上的 JSONC 配置由 OpenCode 读取。没有配置 `model` 时沿用 OpenCode 的原生选择，不自动替换供应商或模型。

```yaml
- insert:
    - id: subagent-opencode
      name: dsh-subagent-opencode
      config:
        command: 'E:\nodejs\node_global\node_modules\@opencode\cli\bin\opencode.exe'
        agent: build
        permissionMode: full-access
    - id: tool-subagent-opencode
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: opencode
        toolName: subagent_opencode
        maxDepth: provider-managed
```

## 实现

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 配置 Schema 和 Provider 注册 |
| `src/run.ts` | CLI 定位、子进程环境、生命周期、诊断和结果结算 |
| `src/wire.ts` | ACP 握手、会话、权限、消息汇集和原生错误处理 |
| `cordis.patch.yml` | Bundle Provider 和官方委派工具挂载 |
| `scripts/build.mjs` | TypeScript 转为发布用 JavaScript，不执行插件 |

每次委派启动一个 `opencode acp` 进程，完成 `initialize`、`session/new`、可选模型配置和 agent 配置，再把运行句柄交给 Harness，提交一次 `session/prompt`。

只接收非空文本块，不继承父对话历史，默认使用父任务工作目录。文件工作区共享。保留官方 `NO_START_CAPABILITIES`、`inheritsParentContext = false`、`settleRunResult` 和 `subprocessRunHandle` 契约。

回答按 ACP `messageId` 汇集，只返回最后一条非空主会话 assistant 文本。思考和子会话文本不复制给父模型，成功终态没有回答时返回错误。取消发送 `session/cancel`；清理尝试 `session/delete` 或 `session/close`，并通过共享 subprocess 服务终止受管进程范围。

OpenCode 会话先创建再删除，不等同于 Codex 的 `ephemeral: true`。进程异常退出、清理失败或原生端不支持删除时，可能留下原生会话；不会枚举或删除其他会话。

## 0.1.2 诊断修订

- 在诊断中加入插件版本，区分新包与仍在使用的旧包。
- 保留 ACP 错误码、原生错误类型、服务、错误字段、可用的 HTTP 状态，以及原生所选模型路由。
- 保留最长 600 字符的原生错误摘要，过滤已知环境凭据、常见 token、认证字段和 URL 中的认证信息、查询参数与片段；不复制完整错误数据、响应体或协议流。
- 将认证、余额、额度、限流、模型不可用、连接和服务故障映射为具体诊断。
- 成功结果的 `diagnostic` 也包含 ACP 所选模型。该字段反映会话配置，不能独立证明供应商实际使用的后端模型；不会修改模型回答正文。

此前本机已安装的 0.1.0 将多数 ACP 错误压成 `prompt / product-error`，丢失具体诊断。已有两次运行记录未保留原生错误，会话也已清理，因此此修订**不能确认原始 prompt 故障的根因或声称已经修复该运行故障**。升级后新的失败报告会包含更具体的诊断证据。

## 构建和打包

```powershell
node scripts/build.mjs
npm pack --ignore-scripts --offline
```

包中包含 `lib/`、源码、类型声明、配置、图标和中英文元数据。构建需要支持 `node:module.stripTypeScriptTypes` 的 Node.js。

**按用户要求，未运行测试、类型检查、插件加载、CLI 握手或模型请求；仅做源码修改、转译和打包。未自动安装，运行兼容性未经执行验证。**

## 来源

- https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.3/packages/subagent/subagent-codex
- https://github.com/anomalyco/opencode/tree/v2.3.0/packages/cli/src/acp
- https://opencode.ai/docs/cli/acp/

许可与上游归属见 `LICENSE` 和 `NOTICE`。
