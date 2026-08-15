# dsh-resume

[English](README.md) | 中文

**状态：功能插件（含兼容补丁），仅在 DeepSeek Harness 0.1.0-rc.6 上测试过。**

`dsh-resume` 为 DSH Web 配置提供两项连续性能力：中断的回合可以在输入框为空时直接续写（不会出现可见的"继续"消息）；DSH 停止时仍在运行的会话，下次启动后会自动恢复。

## 问题

上游 DSH 已经能恢复已存储的会话、修复损坏的日志，但它不会把"空提交"当作续写指令，也不会在进程关闭时自动记下"当时正在运行的会话和子代理"并在下次启动时原样恢复。

## 行为

- 回合被中断时，把已收到的部分文本和推理内容并入会话历史。
- 中断的对话支持空提交续写。
- 在 `~/.dsh/resume-state.json` 中记录正在运行的顶层会话和子代理。
- 只恢复关闭时仍在运行的条目；已完成的回合或用户主动中止的回合不会恢复。
- 状态文件按会话逐个消费：每个成功恢复的会话都会立刻从持久化集合中移除（原子写入）。因此恢复过程中即使崩溃或被强杀，也不会丢失其余会话——下次启动会继续恢复剩下的部分。失败的恢复会保留记录，下次启动重试。
- 启动时自动重试已记录的子代理；失败的条目仍可通过 `resume_interrupted_subagents` 一键重试。
- 恢复诊断写入 `~/.dsh/resume-state.log`。

## 非目标

本插件不会导入其他 agent 的会话、回退任意回合、迁移工作区，也不保证远程 provider 能逐字节重现被中断的流，更不负责修复上游会话日志中的所有竞态。

## 实现机制

宿主插件监听 agent 生命周期事件，并使用官方 `agents.resume` 服务。兼容补丁为以下包补充了"部分回合折叠"和"空提交续写"处理：

- `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`
- `@deepseek-ai/dsh-session@0.1.0-rc.6`
- `@deepseek-ai/dsh-client-ui-conversation@0.1.0-rc.6`

每个补丁块都幂等，并有明确的逆向操作。版本策略默认自适应：如果已安装副本的版本不是 `0.1.0-rc.6`，但每个锚点仍然唯一匹配，就照常打补丁（记为 adaptive 匹配）；锚点漂移则跳过并说明原因。编程选项 `strict` 可恢复"只打精确版本"的旧行为。单个漂移副本不会阻塞其他副本，补丁应用在模块加载期也绝不会抛错——上游升级不会卡死 agent 循环。还原在任何模式下都严格校验版本。

## 兼容性

已在 DeepSeek Harness `0.1.0-rc.6`、Node.js `^22.19.0 || >=24`、pnpm `>=10` 上测试。上游升级后，建议各跑一次 `dsh-resume-restore` 和 `verify:anchors`，确认每个补丁块要么已应用、要么是有意跳过。

## 安装

```sh
dsh plugin --profile web add "github:xiaohj233/dsh-resume#v0.2.1"
```

重启 Web 配置。启动时会先应用守卫式兼容补丁，再启用恢复行为。

## 配置

如需覆盖，在更靠后的配置层修改 `dsh-resume` 行：

```yaml
- id: dsh-resume
  config:
    enabled: true
    restoreDelayMs: 2000
```

`enabled` 控制是否在启动时自动恢复。运行时跟踪始终开启，之后启用时仍能恢复已记录集合。

## 还原与卸载

卸载前先还原官方包文件：

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-resume-restore
dsh plugin --profile web remove dsh-resume
```

未设置 `$DSH_HOME` 时，配置位于用户主目录下（POSIX 为 `~/.dsh/profiles/web`，Windows PowerShell 为 `%USERPROFILE%\.dsh\profiles\web`）；Windows 上请把解析后的路径传给 `pnpm --dir`，不要用 `~`。正常的 Cordis 关闭**不会**撤销补丁——关闭恰恰是连续性状态需要保留的时机。

卸载后 `resume-state.json` 和 `resume-state.log` 不再被读取。如果不再需要其中的会话标识与诊断信息，可手动删除。

## 安全与隐私

状态文件和日志包含会话/子代理标识符、模型与恢复诊断、失败消息。它们不会有意存储凭据值，但应视为私有运行时数据。自动恢复会发起新的模型请求并产生 provider 用量。

## 测试

```sh
npm test
npm run check
npm pack --dry-run
```

测试覆盖：版本拒绝、唯一锚点拒绝、整批原子性、幂等性、补丁/还原的字节级往返、正常关闭行为，以及还原 CLI 的失败路径。

## 局限性与上游现状

上游已提供 `resumeSessionId`、中断回合收尾器、检查点与会话持久化。本插件建立在这些机制之上，只补上缺失的"空提交续写"和"关闭时运行集合恢复"行为。DSH Discussion #420 记录了上游恢复/收尾的序列竞态，本插件不承诺消除它。

## License

MIT。补丁目标均为 MIT 许可，详见 `THIRD_PARTY_NOTICES.md`。
