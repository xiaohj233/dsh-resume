# dsh-resume（中断续接 + 重启自动恢复）

[English](README.md) | 中文

**状态：功能插件（含兼容补丁，Feature Plugin with Compatibility Patch）。仅在 DeepSeek Harness（深度求索 Harness）0.1.0-rc.6 上测试过。**

`dsh-resume` 为 DSH Web profile 增加两种连续性行为：被中断的回合可以通过空提交（empty submit）继续，而不会添加一条可见的 "continue" 消息；DSH 停止时仍在运行的会话可以在下次启动后被恢复。

## 问题

上游 DSH 可以恢复已存储的会话并修复撕裂（torn）的日志，但它不会把空 composer 提交视为续接，也不会在进程关闭时自动重启当时处于活动状态的那一组精确的会话和子代理（subagent）。

## 行为

- 当回合被中断时，把已收到的部分文本和推理（reasoning）内容并入会话历史。
- 支持对中断的对话进行空提交续接。
- 在 `~/.dsh/resume-state.json` 中记录处于活动状态的顶层会话和子代理。
- 只恢复关闭时被记录为运行中的条目；已完成的回合或用户中止的回合不会被恢复。
- 状态文件按会话逐个消费：每个成功恢复的会话会立即（原子写入）从持久化集合中移除，因此恢复过程中发生崩溃或被强杀也不会丢失剩余会话——下次启动会继续恢复剩下的部分。失败的恢复会保留记录，并在下次启动时重试。
- 启动时自动重试已记录的子代理；失败的条目仍可通过 `resume_interrupted_subagents` 使用。
- 将恢复诊断信息写入 `~/.dsh/resume-state.log`。

## 非目标

本包不会从其他 agent 导入会话、回退任意回合、迁移工作区（workspace）、保证远程 provider 能逐字节（byte-for-byte）重现被中断的流，或修复上游会话日志中的每一个竞态（race）。

## 机制

主机插件（host plugin）监听 agent 生命周期事件，并使用官方的 `agents.resume` 服务。兼容补丁（compatibility patch）为以下包添加了部分回合折叠（partial-turn folding）与空提交处理：

- `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`
- `@deepseek-ai/dsh-session@0.1.0-rc.6`
- `@deepseek-ai/dsh-client-ui-conversation@0.1.0-rc.6`

每个目标 hunk（补丁块）都是幂等的（idempotent），并有显式的逆操作。版本策略默认为自适应（adaptive）：当安装版本与 `0.1.0-rc.6` 不同的副本在每个 hunk 锚点（anchor）都唯一匹配时，仍会被打补丁（记录为 adaptive match，自适应匹配）；锚点发生漂移（drift）时则跳过并给出原因。编程式 `strict` 选项会恢复旧的仅精确版本匹配（exact-version-only）的应用行为。一个发生漂移的副本永远不会阻塞其他副本，且补丁应用在模块加载期间绝不会抛出异常，因此上游升级不会让 agent loop 变砖（brick）。在所有模式下，还原（restore）都保持严格的版本守卫（version-guarded）。

## 兼容性

已在 DeepSeek Harness `0.1.0-rc.6`、Node.js `^22.19.0 || >=24` 和 pnpm `>=10` 上测试。上游升级后，运行一次 `dsh-resume-restore` 和 `verify:anchors`，确认每个 hunk 要么已应用、要么被有意跳过。

## 安装

```sh
dsh plugin --profile web add "github:xiaohj233/dsh-resume#v0.1.0"
```

重启 Web profile。启动时会先应用受保护（guarded）的兼容补丁，再启用恢复行为。

## 配置

需要时，可在后续的 profile patch 中覆盖 `dsh-resume` 行：

```yaml
- id: dsh-resume
  config:
    enabled: true
    restoreDelayMs: 2000
```

`enabled` 控制启动时的恢复。运行时跟踪始终保持活动，因此之后启用恢复的启动可以还原已记录的那组条目。

## 卸载与还原

移除插件前，先还原官方包文件：

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-resume-restore
dsh plugin --profile web remove dsh-resume
```

当 `$DSH_HOME` 未设置时，profile 位于主目录下（POSIX：`~/.dsh/profiles/web`；Windows PowerShell：`%USERPROFILE%\.dsh\profiles\web`）；在 Windows 上，请将解析后的路径传给 `pnpm --dir`，而不是 `~`。正常的 Cordis 关闭**不会**撤销补丁；关闭正是必须保留连续性状态的时刻。

卸载后，`resume-state.json` 和 `resume-state.log` 不再被读取。如果不再需要其中的会话标识符和诊断信息，请手动删除它们。

## 安全与隐私

状态文件和日志文件包含会话/子代理标识符、模型与恢复诊断信息以及失败消息。它们不会有意存储凭据值（credential value），但应被视为私有运行时数据。自动恢复可能发起新的模型请求并产生 provider 用量。

## 测试

```sh
npm test
npm run check
npm pack --dry-run
```

测试套件覆盖：精确版本拒绝、唯一锚点拒绝、整次运行的原子性（atomicity）、幂等性、逐字节精确（byte-exact）的补丁/还原往返、正常关闭行为，以及 restore CLI 失败场景。

## 局限性

上游已提供 `resumeSessionId`、中断回合的关闭器（closer）、检查点（checkpoint）和会话持久化。本包构建在这些机制之上，只修补缺失的空续接（empty-continuation）行为和关闭集（shutdown-set）恢复行为。DSH Discussion #420 记录了一个上游的 resume/closer 序列竞态（sequence race），本包并不声称能消除它。

## License

MIT。补丁目标均为 MIT 许可；参见 `THIRD_PARTY_NOTICES.md`。
