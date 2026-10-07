# 更新日志

本项目的所有显著变更都记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

### 改变

- **检查是否还开着，现在由继续消息自己说**：`decisionWindow` 是插件进程内的状态，模型看不到；错过回合边界的模型会在工作回合里再调一次 `watchdog_decide(decision="continue")`，拿回一句「没有检查开着」，于是以为仍在检查回合、把刚交付过的回答重写一遍（实测：一轮里 2,115 字的报告 → 检查 → `continue` → 2,706 字的改版报告）。两处文案各补一句：继续消息开头声明「watchdog 检查已结束，这是普通工作回合，所有工具都可用」；决策提示声明「上一回合自己结束不算被中断，已经写出的回答就算交付过了，重写/扩写/换排版不是还有活，没活就答 `done`」。同时把「检查外调 `continue`」的退回文案从「没有检查开着」改成「检查已经答过了」——前者会让模型以为整次检查消失了。
- **信号从「文字」改成工具调用：`stop_watchdog` 重命名为 `watchdog_decide(decision, note)`**。决策回合原来靠文字区分答案（“有文字 = 还有活”），但这把两个用途挤在同一个通道里：模型把文字当交付物，watchdog 把同一段文字当布尔信号、写完就折叠掉——模型写得越认真，删得越干净。而且模型想接着干活时没有任何正当工具可调，只能去撞被拦截的工具，撞不明白就按唯一的出口（`watchdog_decide`）停下。现在信号只有一个工具调用：
  - `decision: "continue"` → 还有活，watchdog 发继续消息开真正的工作回合；
  - `decision: "done"` → 任务完成；
  - `decision: "wait_user"` → 在等用户拍板（行为与 `done` 一致，只是卡片文案不同）；
  - `note`（可选）→ 一行短话，只给卡片/用户看，不参与判定；
  - 只回文字、不调工具 = `empty`：写卡片、发折叠标记、不发继续消息、重新倒计时，照样扣 `max` 预算（不 fallback，只面向会调工具的模型）。
- **收尾不再用 `ctx.abort()`，改用工具结果的 `terminate: true`（整套幻影行机制被删掉）**。答 `continue` 与答 `done`/`wait_user` 现在都靠终止性工具结果结束回合：pi 在工具批次全部 `terminate` 时跳过后续模型调用，等于「这一轮到此为止」，但**不抛异常**，所以不会再有那条空的 `error` 幻影行。连带删除：`stopAbortPending`、`selfAbortPending`、`onMessageEnd` 的改写、`isEmptyAssistantContent`，以及 `onAgentEnd`/`onAgentSettled` 里为它们加的跳过守卫。三个行为差异：
  - 用户在检查回合里发的消息**不再被默默丢掉**：abort 会把 pi 的队列一起清空（交互模式下被退回编辑器），而现在模型在同一轮里就会答它；
  - 被拦截的工具调用（如检查回合里伸手去调 `bash`）也带 `terminate`，因此「伸手调工具 + 调 `watchdog_decide`」这种混合批次一样在这一轮结束，不会多买一次模型调用；只伸手不回答则按 `empty` 收尾、重新倒计时（行为与「模型一声不吭」一致）；
  - 主动收尾（工作回合末尾直接调 `watchdog_decide`）时，模型**已经流出的**收尾文字不再被抹掉（工具调用发生在整条 assistant 消息落地之后，abort 本来就截不住它，只是让它不出现）。这段文字仍在主动收尾的折叠区间内，代价为零。
- **用户插话的判定改看落盘的用户消息，不再只看队列**：`!ctx.isIdle() || ctx.hasPendingMessages()` 在 `terminate` 下不再够用——pi 按 `steer` 投递催促，用户的消息（连同模型对它的回答）会在同一轮里被消化掉，回合结束时队列已是空。现在 `message_end` 里记一笔「这轮出现过 `role: "user"` 的消息」，让这次检查以 `superseded` 收尾，不会在用户自己的回合上再压一条继续消息。
- **非法 `decision` 与「工作回合里调 `continue`」改成 `throw`**：pi 只把 `execute()` 抛出的异常标记为工具错误（返回对象里写 `isError: true` 会被忽略），而这两种情况本来就该让模型看到、并在同一轮里改正。测试相应改成断言抛错。
- **决策回合的文字不再被剥离**：文字不是信号，它跟着交换一起折叠掉，同时完整留在会话文件里——那是「模型为什么这么答」的唯一痕迹。`DecisionWindow` 的 `replyText` / `sawToolCall` 与 `DECISION_REPLY_MAX_CHARS` 一并移除。
- **卡片新增 `decision` 字段并把标签改成能指导行动的话**：`stop` 的默认标签是 `finished — stopped on purpose`，`wait_user` 换成 `waiting on you — reply to resume`，`empty` 换成 `no watchdog_decide call from model`。`note` 截断改成 `DECISION_NOTE_MAX_CHARS`＝200 字符（参数描述里要求一行、不超 100 字，代码截断只是兵底）。
- **催促文案把「文本 = 还有活」这条映射明写出来，并禁止复述已经交付的回答**：决策消息原来只说「还有活就回一句文字，没活就调 `watchdog_decide`」，模型很容易用「我干完了」这种完成声明回一句文字——按映射这就是「还有活」，于是白跑一轮继续消息，还把已经交付过的最终答案又总结了一遍。更糟的是那句重复总结长在折叠区间**之后**（折叠只丢检查轮自己的提示与回复），会永久留在上下文里，正好是折叠想避免的浪费。（本版本已把文字通道整个废掉，这条改动只适用于旧协议。）
- **倒计时归零时如果会话正忙，不再作废这次空闲**：以前 `fireNudge` 发现 `isIdle()` 为假就直接 return，靠「AI 跑完会发 `agent_settled` 重装计时器」这条假设兜底。但 `isIdle()` 还包含「pi 正在压缩上下文」（手动 `/compact`、自动压缩、分支摘要都算），这条路径**永远不发 `agent_settled`**（压缩只发 `session_compact` / `compaction_end`），于是计时器被丢掉、ticker 也不会重建它，状态栏停在 `⏱▶ n/max` 一直不动，直到你下一条消息才恢复。现在归零时若不空闲就置 `waitingForIdle`，交给每秒一次的 ticker：会话一空闲立刻重新装一整段倒计时（不是立刻发）。任何一次重装倒计时（`clearCountdown`）都会清掉这个标记，所以 AI 正常跑完那条路不会出现「ticker 又把计时器重置」的问题。
- **发决策消息撞上过期 ctx 时彻底停掉，而不是留一个半开的决策窗口**：`sendDecision` 的 `try/catch` 原来把任何异常都当成「AI 刚好跑起来了」，只退一次计数并清窗口。实际上 pi 自己会把异步发送失败吞掉（`sendCustomMessage(...).catch(...)`），能同步抛的只有一种：会话被替换（`/clear`、`/resume`、`/fork`、reload）后加载器那层的 `assertActive()`。真撞上时旧代码会留下一个已建的 `decisionWindow`——下一轮里 AI 的**所有工具**都会被当成决策回合拦掉。现在 catch 里改为：清窗口、退计数、`stopWithoutCtx()` 直接关掉监控（只清状态，不碰 `ctx.ui` 也不发 `watchdog:state`，因为过期 ctx 上这些调用同样会抛）。
- **AI 主动收尾会留一张卡片，并在请求视图里折叠掉**：`watchdog_decide(decision="done"|"wait_user")` 在工作回合末尾被直接调用（不在决策回合里）时，以前只会把状态栏清掉或改成 `⏱⏸`，时间线上没有任何一行。这次补两件事：一是 `pi-watchdog:decision` 历史记录（`outcome: "stop"` + `proactive: true` + `decision`），渲染成 `⏱ watchdog: finished — stopped on purpose · monitoring paused · no check`（后两截按实际情况出现）；二是同一次调用另发一条折叠标记 `pi-watchdog:stopped`，在发出请求前把该回合的收尾文字、工具调用与返回整段删掉。标记以工具调用 id 定位区间，不靠保存顺序，因此 AI 在调用之后又写了一句收尾也会一并落在区间内；找不到那次调用（已被压缩）就保留，宁可不折叠也不误删。在决策回合里停止仍走原来的路径，只在结算时写一张带 `suspended` 的卡片，不会多出一行；历史卡片与标记共用同一个 id。
- **时间线上的卡片带 `watchdog:` 前缀**：决策提示与决策结果两类卡片都由 `⏱ watchdog: ...` 起头，和其他插件输出的卡片区分开，一眼看得出是谁发的。
- **决策检查没拿到答案时统一「重走倒计时」，并把空回复也算进去**：以前 provider 报错（网络抖动、限流、超时）会**当场**补发一条新检查，不等倒计时；实测中还有一种更隐蔽的失败：provider 干干净净地结束了流、但一个字段都没给（`stopReason: "stop"`、零 token、没有 text 也没有 tool call）。这种空回复以前按构造落进「继续」分支——时间线上卡片只有一句 `still working`（没有回复可展开，所以连 `· click to expand` 都没有），紧接着一条继续消息，白跑一个真实工作回合（实测那次烧掉 4949 token）。现在两类失败走同一条路：写一张可展开的结果卡片（provider 报错保留原文；空回复写 `the model sent no text and no tool call — no work turn started, countdown restarted`）、发折叠标记、**不发继续消息**、重新开始倒计时。所谓「重试」就是下一次倒计时到点发出的检查，仍从 `max` 预算里扣一次，所以连续失败照样会在 `max` 次后按「催不动」停下。空回复单列为 `empty` 结果（`⏱ watchdog: empty reply from model`），和 provider 报错的 `failed` 卡片区分开，一眼看得出「模型没说话」还是「provider 出错了」；`failed` 的文案也跟着改成 `check failed, will retry`（因为不再有「立刻」这回事）。判定空回复时额外排除了「只有工具调用、没有文字」的回合——那种是模型想干活（工具被拦截），仍按「继续」处理。
- **决策结果上屏：时间线上多一行摘要，可展开看 AI 的回复**。以前一次检查只看得见「问题」（决策提示），模型那句被剥离的回复只能去 `/tree` 或会话文件里找。现在 `pi-watchdog:decision` 记录也注册了渲染器，在提示下方显示一行 `⏱ watchdog: still working · click to expand` / `⏱ watchdog: stopped on purpose` / `⏱ watchdog: superseded` / `⏱ watchdog: check failed, will retry`，点击展开就是那句回复；常驻模式下 AI 主动停止时多标 `· monitoring paused`。先调 `watchdog_decide` 的那次检查没有回复可看（收尾文字在工具调用之前输出，落盘时已清空），这种卡片只显示结果。两种摘要的展开状态各自记在 `src/expanded.ts`，每开新会话时清空——渲染器组件由 pi 缓存，会跨会话存活。折叠逻辑不变：它仍是 `CustomEntry`，不进模型上下文。
- **TUI 去噪：检查不再发通知，结果和提示各占一行折叠摘要**。发起检查时不再发 `ui.notify`（info 通知在 pi 里是永久时间线行），改由决策消息本身在时间线里显示一行 `⏱ watchdog: Sending decision message · click to expand`（展开看发给模型的提示全文）；`watchdog_decide` 的调用/结果行被隐藏（`renderShell: "self"` + 空 `renderCall`/`renderResult`）；`ctx.abort()` 不再被使用，因此也不会再产生红色的 `Error: This operation was aborted` 幻影消息。决策结果写进会话历史；常驻模式下的「挂起 vs 已停止」记为 `suspended` 字段。
- **`watchdog_decide` 支持主动调用**：AI 真正完工（或在等用户决策）时，不必等倒计时归零，可在工作回合末尾直接调用它收尾，省掉一次「干等 timeout + 空决策往返」；普通模式彻底停止，`mode=keep` 下挂起。工具 description 与「未运行」提示文案随之改写。
- **催促拆成「决策回合 + 继续消息」**：空闲超时后先发一条禁止干活的决策消息（除 `watchdog_decide` 外的工具被拦截），AI 用它回答还有活不活，watchdog 随即发继续消息触发真正的工作回合；答停止就不发。
- **上下文回滚（beta，opt-in）→ 上下文折叠（默认开启）**：决策交换在每次 provider 请求前被移除（决策消息 + AI 回复 + 被拦截的工具对），只保留继续消息；非破坏性，不改写会话记录，无需 `navigateTree` / 命令跳板。

### 移除

- `PI_WATCHDOG_ROLLBACK` 环境变量、内部命令 `/watchdog-internal`、`navigateTree` 回滚链路（跳板 / 重试 / 退避 / 尾部校验）。
- 决策回合回复的文字剥离逻辑与 `DecisionWindow.replyText` / `sawToolCall`；`DECISION_REPLY_MAX_CHARS` 被 `DECISION_NOTE_MAX_CHARS` 取代。
- 自伤 abort 的全套善后代码：`stopAbortPending`、`selfAbortPending`、`onMessageEnd` 里的幻影 `error` 行改写、`isEmptyAssistantContent`。工具不再调用 `ctx.abort()`，自然不会产生「请求中止」行。

### 新增

- 决策结果记录（`pi-watchdog:decision`）：每次决策检查结算后写一张 `appendEntry`，记下结果（继续 / AI 主动停止 / 用户接管作废 / 检查失败 / 没调工具）、`decision`（`done` / `wait_user`）、挂起状态与 AI 传给 `note` 的短话（截断 200 字符，失败时存 provider 报错原文）。它不注册 TUI 渲染器（不在时间线出现），不进模型上下文、不参与折叠，`/resume` 后仍可从 `/tree` 或会话文件读到。
- 决策检查没拿到答案的回归测试（`tests/decision-retry.test.ts`）：失败后改走倒计时再发下一条（不再当场补发）、重试计入 `max`、空回复按失败处理且不发继续消息、连续空回复只耗预算、只有工具调用（且不是 `watchdog_decide`）的回合算没答、用户接管不重试、pi 内部重试救回后照常继续。
- 新协议的专项回归测试（`tests/watchdog-decide.test.ts`）：答 `continue` 全程不 abort（`abortedTurns` 为 0）、只回文字落 `empty` 且不发继续消息、非法 `decision` 抛错让模型能重试、工作回合里调 `continue` 同样抛错、混合批次（被拦截的工具 + `watchdog_decide`）只花一次模型调用、只伸手调被拦截工具则按 `empty` 收尾、工具 description / `promptSnippet` / `promptGuidelines` 与决策提示的三取值保持一致。
- 测试 mock 按真实 pi 的批次语义执行工具：`runToolBatch` 走 `tool_call` 拦截、只执行 `watchdog_decide`、按「全部 `terminate` 才算终止」返回，并像 pi 一样把 `execute()` 抛出的异常记成工具错误（`rt.toolErrors`）。
- `pi.on("context")` 折叠钩子与 `foldWatchdogContext` 纯函数（跨 resume/reload 成立，关联不完整时 fail closed）。
- 多会话共存回归测试（`tests/session-reuse.test.ts`）：同一进程里连开两个会话，两个都必须拿到 `watchdog_decide`。现有用例每条都 `vi.resetModules()`，只覆盖「模块首次加载」，所以漏掉了这个缺陷。
- 决策消息改为带 `exchangeId` 的 CustomMessage（`pi-watchdog:nudge` / `:continuation` / `:fold`），折叠关联只靠消息自身的 `customType` + `exchangeId`，不依赖额外落盘信息。
- 决策消息的渲染层不再覆盖任何文字（决策回合的文字不再被剥离）。
- 决策期间用户插话 / 回合没回到空闲时写 `superseded` 终点标记，整段交换照样被折叠，不会把决策提示词永久留在上下文。
- 用户按 `Esc` 中止一轮后，watchdog 不再继续催促（状态栏 `⏱⏹`）：本次空闲不开始倒计时，等用户发下一条消息、AI 重新运行后自动恢复。`watchdog:state` 事件会广播 `interrupted` 字段。

### 修复

- **同一进程的第二个会话拿不到工具**：`toolRegistered` 在 `8ce99c8` 拆分时被搬到了模块顶层，而 pi 只为新会话重跑插件工厂、不重载模块，于是下一个会话带着上一个会话的 `true` 开局，`startWatchdog` 跳过注册。该会话的工具表是空的，AI 看不到工具、`onToolCall` 的白名单永不命中，决策回合只能以 `continue` 收场，一路催到上限（实测 14 次）。现在改回 `427eff6` 的语义：开关留在模块层，但每次工厂执行时先重置为 `false`。
- **决策提示不再自相矛盾**：原文写着「本回合不要用工具」，紧接着又要求「以 `watchdog_decide` 收尾」。现在提示词与拦截原因都改成「除 `watchdog_decide` 外的工具都被拦截」，与 `onToolCall` 的实际放行名单一致。
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

- `PI_WATCHDOG_ON_STOP` hook：`watchdog_decide` 做出停止决定时向指定文件写入完成信号，供外部脚本监听。

### 修复

- rollback 重试耗尽后清理 pendingRollback，不再在每次 agent_settled 时重复触发 jump；校验拒绝与跳转失败现在会以警告形式上报。

## 1.0.0 - 2026-09-18

首个正式版本。pi 插件：watchdog 自动监控，AI 停止输出后倒计时并自动催促继续，支持上下文回滚（beta）与缓存优化。
