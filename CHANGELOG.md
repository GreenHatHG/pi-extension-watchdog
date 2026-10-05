# 更新日志

本项目的所有显著变更都记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

### 改变

- **AI 主动收尾会留一张卡片，并在请求视图里折叠掉**：`stop_watchdog` 在工作回合末尾被直接调用（不在决策回合里）时，以前只会把状态栏清掉或改成 `⏱⏸`，时间线上没有任何一行。这次补两件事：一是 `pi-watchdog:decision` 历史记录（`outcome: "stop"` + `proactive: true`），渲染成 `⏱ watchdog: stopped on purpose · monitoring paused · no check`（后两截按实际情况出现）；二是同一次调用另发一条折叠标记 `pi-watchdog:stopped`，在发出请求前把该回合的收尾文字、`stop_watchdog` 调用与返回整段删掉。标记以工具调用 id 定位区间，不靠保存顺序，因此 AI 在调用之后又写了一句收尾也会一并落在区间内；找不到那次调用（已被压缩）就保留，宁可不折叠也不误删。在决策回合里停止仍走原来的路径，只在结算时写一张带 `suspended` 的卡片，不会多出一行；历史卡片与标记共用同一个 id。
- **时间线上的卡片带 `watchdog:` 前缀**：决策提示与决策结果两类卡片都由 `⏱ watchdog: ...` 起头，和其他插件输出的卡片区分开，一眼看得出是谁发的。
- **检查失败自动重试，并计入 `max` 次数**：决策检查本身撞上 provider 错误（网络抖动、限流、超时）时，以前只会按 `superseded` 记录一张卡片，然后老实等下一次空闲倒计时——白等一个 timeout。现在失败会当场补发一条新检查（不等倒计时），并把这次重试当成一次正常催促计入 `max` 预算，所以连续失败也会在 `max` 次后按「催不动」自动停下，不会绕过卡死保险。判定放在 `agent_settled`（那时才确定没有内部重试会救回来），`agent_end` 只把最新一次尝试的结果记进决策窗口；`stop_watchdog` 主动中止留下的幻影 `stopReason: "error"` 消息被排除在外。失败那张卡片新增 `failed` 结果（`⏱ watchdog: check failed, retrying`），展开可见 provider 的报错原文。
- **决策结果上屏：时间线上多一行摘要，可展开看 AI 的回复**。以前一次检查只看得见「问题」（决策提示），模型那句被剥离的回复只能去 `/tree` 或会话文件里找。现在 `pi-watchdog:decision` 记录也注册了渲染器，在提示下方显示一行 `⏱ watchdog: still working · click to expand` / `⏱ watchdog: stopped on purpose` / `⏱ watchdog: superseded` / `⏱ watchdog: check failed, retrying`，点击展开就是那句回复；常驻模式下 AI 主动停止时多标 `· monitoring paused`。先调 `stop_watchdog` 的那次检查没有回复可看（收尾文字在工具调用之前输出，落盘时已清空），这种卡片只显示结果。两种摘要的展开状态各自记在 `src/expanded.ts`，每开新会话时清空——渲染器组件由 pi 缓存，会跨会话存活。折叠逻辑不变：它仍是 `CustomEntry`，不进模型上下文。
- **TUI 去噪：检查不再发通知，结果和提示各占一行折叠摘要**。发起检查时不再发 `ui.notify`（info 通知在 pi 里是永久时间线行），改由决策消息本身在时间线里显示一行 `⏱ watchdog: Sending decision message · click to expand`（展开看发给模型的提示全文）；`stop_watchdog` 的调用/结果行被隐藏（`renderShell: "self"` + 空 `renderCall`/`renderResult`）；`ctx.abort()` 产生的幻影 `Error: This operation was aborted` 消息在本插件主动中止后（决策窗口内与窗口外）都被清成空消息。决策结果写进会话历史；常驻模式下的「挂起 vs 已停止」记为 `suspended` 字段。
- **`stop_watchdog` 支持主动调用**：AI 真正完工（或在等用户决策）时，不必等倒计时归零，可在工作回合末尾直接调用它收尾，省掉一次「干等 timeout + 空决策往返」；普通模式彻底停止，`mode=keep` 下挂起。工具 description 与「未运行」提示文案随之改写，abort 幻影消息的清理也扩展到决策窗口外（仅限本插件刚触发的 abort，真实 provider 错误照常显示）。
- **催促拆成「决策回合 + 继续消息」**：空闲超时后先发一条禁止干活的决策消息（除 `stop_watchdog` 外的工具被拦截），AI 回文字 = 还有活，watchdog 随即发继续消息触发真正的工作回合；AI 调 `stop_watchdog` = 停止。
- **上下文回滚（beta，opt-in）→ 上下文折叠（默认开启）**：决策交换在每次 provider 请求前被移除（决策消息 + AI 回复 + 被拦截的工具对），只保留继续消息；非破坏性，不改写会话记录，无需 `navigateTree` / 命令跳板。

### 移除

- `PI_WATCHDOG_ROLLBACK` 环境变量、内部命令 `/watchdog-internal`、`navigateTree` 回滚链路（跳板 / 重试 / 退避 / 尾部校验）。

### 新增

- 决策结果记录（`pi-watchdog:decision`）：每次决策检查结算后写一张 `appendEntry`，记下结果（继续 / AI 主动停止 / 用户接管作废 / 检查失败）、挂起状态与截断 300 字的 AI 回复（失败时存 provider 报错原文）。它不注册 TUI 渲染器（不在时间线出现），不进模型上下文、不参与折叠，`/resume` 后仍可从 `/tree` 或会话文件读到。
- 决策重试回归测试（`tests/decision-retry.test.ts`）：失败后立刻补发、重试计入 `max`、用户接管不重试、pi 内部重试救回后照常继续、`stop_watchdog` 幻影错误不误判，共 5 例。
- `pi.on("context")` 折叠钩子与 `foldWatchdogContext` 纯函数（跨 resume/reload 成立，关联不完整时 fail closed）。
- 多会话共存回归测试（`tests/session-reuse.test.ts`）：同一进程里连开两个会话，两个都必须拿到 `stop_watchdog`。现有用例每条都 `vi.resetModules()`，只覆盖「模块首次加载」，所以漏掉了这个缺陷。
- 决策消息改为带 `exchangeId` 的 CustomMessage（`pi-watchdog:nudge` / `:continuation` / `:fold`），折叠关联只靠消息自身的 `customType` + `exchangeId`，不依赖额外落盘信息。
- 决策回合的模型回复在落盘前被剥离（带工具调用时只保留工具调用块），避免这段已折叠内容在 TUI 里以原始消息的形式重复出现；剥离前的内容只留在 `pi-watchdog:decision` 历史记录里。
- 决策期间用户插话 / 回合没回到空闲时写 `superseded` 终点标记，整段交换照样被折叠，不会把决策提示词永久留在上下文。
- 用户按 `Esc` 中止一轮后，watchdog 不再继续催促（状态栏 `⏱⏹`）：本次空闲不开始倒计时，等用户发下一条消息、AI 重新运行后自动恢复。`watchdog:state` 事件会广播 `interrupted` 字段。

### 修复

- **同一进程的第二个会话拿不到 `stop_watchdog`**：`toolRegistered` 在 `8ce99c8` 拆分时被搬到了模块顶层，而 pi 只为新会话重跑插件工厂、不重载模块，于是下一个会话带着上一个会话的 `true` 开局，`startWatchdog` 跳过注册。该会话的工具表是空的，AI 看不到工具、`onToolCall` 的白名单永不命中，决策回合只能以 `continue` 收场，一路催到上限（实测 14 次）。现在改回 `427eff6` 的语义：开关留在模块层，但每次工厂执行时先重置为 `false`。
- **决策提示不再自相矛盾**：原文写着「本回合不要用工具」，紧接着又要求「以 `stop_watchdog` 收尾」。现在提示词与拦截原因都改成「除 `stop_watchdog` 外的工具都被拦截」，与 `onToolCall` 的实际放行名单一致。
- **会话替换（`/clear`、`/resume`、`/fork`）后不再触碰失效的旧 ctx**：`startWatchdog` 现在把新会话的 `ctx` 传给 `teardown`，`session_shutdown` 也会清空缓存的 `activeCtx`，修掉 `This extension ctx is stale after session replacement` 报错。
- **决策回合被 `Esc` 中止时不再误判为「还有活 → 继续」**：中止发生在决策窗口内时按 `superseded` 收口（不发继续消息、整段交换折叠），并在中止的回合里夹有真实用户消息时提示「插话可能未被处理，请重发」。

### 文档

- README「工作原理 / token 开销 / 缓存」按新流程重写；「上下文回滚（beta）」小节替换为「上下文折叠（默认开启）」。

### 构建

- 新增 devDependency `@earendil-works/pi-tui`（仅用于本地 vitest/tsc 解析；运行时由 pi loader 的模块别名提供，不随包发布）。

## 1.1.1 - 2026-09-21

### 文档

- README 安装说明不再写死 git tag：推荐命令改为跟踪默认分支，`pi update` 即可升级；另附锚定 `v1.1.0` tag 的锁定版本写法。

## 1.1.0 - 2026-09-21

### 新增

- `PI_WATCHDOG_ON_STOP` hook：`stop_watchdog` 完成时向指定文件写入完成信号，供外部脚本监听。

### 修复

- rollback 重试耗尽后清理 pendingRollback，不再在每次 agent_settled 时重复触发 jump；校验拒绝与跳转失败现在会以警告形式上报。

## 1.0.0 - 2026-09-18

首个正式版本。pi 插件：watchdog 自动监控，AI 停止输出后倒计时并自动催促继续，支持上下文回滚（beta）与缓存优化。
