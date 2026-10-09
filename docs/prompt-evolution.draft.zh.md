# 催促 Prompt 的演进：每一次翻车与修复

> 每一代 prompt 的原文都能在 git 历史里核对；session 实证标了路径与模型，thinking 原文是模型自己的第一手材料。

## 第 0 代：一句中文（`4750005`）

```
若任务已全部完成，请调用 stop_watchdog 工具停止自动继续，否则继续执行
```

**Session 实证**：`~/.pi/agent/sessions/--Users-jooooody-Projects-pi-watchdog--/2026-09-06T14-25-11-409Z_01a0771b-….jsonl`，模型 glm-5.3-flash，thinking=max。14:39:54 到 14:59 之间这条 prompt 连发 13 次，每次之间 assistant 只有 thinking、没有实际动作。有一次 thinking 原文直接写着：

> The user's message is the watchdog nudge message… the task is NOT complete, so I should continue executing.

**但「只有 thinking」不是 prompt 的锅，是 provider 不稳定**：落盘数据显示那些回合全是 `stopReason: "error"`、`errorMessage: "Stream ended without finish_reason"`——流被第三方 API 掐断在 thinking 阶段，text 和 toolCall 一个都没流出来。这个 session 里这种错误 30 次；9 月的 62 个 glm-5.3-flash watchdog session 加起来 494 次。14:44:47 那个回合 thinking 有 4.7 万字符，模型其实把「这是 watchdog 发的、任务没完成、该接着实现」推理得完全正确，然后流断了——**prompt 语义没错，答案没送到**。14:44:47 那个回合 thinking 有 4.7 万字符，模型其实把「这是 watchdog 发的、任务没完成、该接着实现」推理得完全正确，然后流断了——**prompt 语义没错，答案没送到**。

另外当时还没有自动重试：第 0 代没有决策检查，报错之后 pi 不会自己补，只能等下一次倒计时（`a9a42d1` 才把「检查没拿到答案统一重走倒计时」补上）。这段「连发 13 次」反而正好是 watchdog 存在的意义本身：provider 抖动导致 AI 停住，替你敲「继续」。

**prompt 层面的坏点（真实存在，在别的场景暴露）**：

- **把催促当用户批准，按默认建议接着跑**。9 月 16 日 08:31 那个 session（`…/2026-09-16T08-31-30-754Z_01a0a957-a….jsonl`，glm-5.3-flash, low）：上一轮已经给出「pre-commit 用原生 hook 还是用 husky」的方案、在等用户拍板；09:06:37 催促到达，AI 回「用户未回复，我按推荐方案（原生 hook，比 husky 轻）继续接入，不满意随时可改」——用户还没拍板，「否则继续执行」被当成了许可。
- **「等用户决策」分支缺失**：第 0 代 prompt 里根本没这条，AI 等用户回复时收到催促只能走「否则继续执行」继续改代码，或者靠模型自觉调 `stop_watchdog` 挂起。反例（模型自觉、prompt 没帮上忙）：`…/2026-09-16T08-13-54-….jsonl`（glm-5.3-flash, low）08:18:30，AI 回「讨论已给出，等你确认方案（A/B/C）后我再动手改」并调 `stop_watchdog` 挂起——这个行为是模型自己想出来的，prompt 里没写。
- 这两点在 9 月 16 日 debug session（`…ensoai-workspaces-pi-watchdog-debug--/2026-09-16T14-35-52-….jsonl`，glm-5.3-flash, low）里被明确讨论过：14:43:05 AI 指出用户提议的版本删掉了「等待用户决策」分支，「那正是解决『先讨论再修改被当成批准』的关键」。

## 第 1 代：英文三分支（`6288f75`，9 月 16 日）

```
[Automated, not user input, not approval] ① All tasks done → call stop_watchdog to stop.
② Not done, no user decision needed → continue.
③ Waiting for user's reply/confirmation → don't change code, call stop_watchdog and wait.
```

**出处**：`…ensoai-workspaces-pi-watchdog-debug--/2026-09-16T14-35-52-….jsonl`（glm-5.3-flash, low）。这版不是作者一个人想出来的：14:42:38 用户先提「加前缀、换英文更短」，AI 14:43:05 指出用户的版本删掉了「等用户决策」分支（那正是解决「先讨论再改被当成批准」的关键），14:44:48 定稿英文三分支，14:52:15 提交。

**修的**：被误认为用户批准。但架构还是「直接触发工作回合」，没有决策检查。

**直接触发工作回合的翻车实证**：`~/.pi/agent/sessions/--Users-jooooody-Projects-pi-watchdog--/2026-09-17T09-55-17-696Z_01a0aeca-….jsonl`，模型 glm-5.3-flash，thinking=low。12 次催促里能看清这条架构的问题：催促一发，模型下一跳就是真实的编辑和 `bash`——没有中间的检查回合。最典型的一次在 10:26:18：用户 10:25:00 只发了半句反馈（「这个感觉跟前面的问题没有联系啊，还有标题……」），AI 10:26:13 刚交完一轮重写，5 秒后催促到了，模型 10:26:53 直接又改了一处 README、10:27:47 又跑了 `git diff` 全文核对——催促被当成了「你批准继续」，模型自己决定再核对一遍。thinking 原文（10:27:47）写的是它在猜「用户把同样的文案又贴了一遍，可能想让我改别的地方」，然后自己去干了——决策检查缺失时，模型只能靠猜。另一个能看清这条架构的 session：`~/.pi/agent/sessions/--Users-jooooody-.local-bin--/2026-09-22T04-39-55-….jsonl`，glm-5.3-flash。这条展现的是另一个坏点——**催促能把模型从「等用户」里拖出来**：模型 04:52:39 交付了取证结论、声明「等你确认后再动手」并调了 `stop_watchdog`（waiting on user 分支走对了）；但催促接连又来了两次（04:52:57、04:53:07），中间模型只有 thinking、没有任何动作，第二次催促之后模型就缴械了——04:53:43 重新开始跑 `bash` 取证（thinking 原文里全是「Need to test that」这类自问自答），而用户真正的输入（04:54:19「纯标准库 Python：ps快还是psutil查询快」）是在这之后才到的。没有检查回合把工具拦住，waiting on user 分支只是 prompt 里的一句建议，重复的催促一压上来模型就守不住。

对照同一 session 的 10:02:08 那次：任务真完了，模型直接调 `stop_watchdog` 结束，行为正确——所以问题不在模型愿不愿意停，而在「还有活但该不该现在干」没有一回合让模型回答，也没有一回合把工具拦住。

## 第 2 代：触发行 + 追加（`d0c31dc`）

```
DEFAULT_MESSAGE = "[Automated, not user input] If work remains, continue; otherwise call stop_watchdog."
```

改动很小但关键：`message=` 配置从「替换整条文案」变成「只追加 `Task instruction: …`」。触发行语义永不缺席——用户自定义文案再怎么写，也不会把「非用户输入」声明和停止出口挤掉。

## 第 3 代：决策回合诞生（`8ce99c8`）

```
[Automated, not user input] Watchdog check — do not use tools in this turn.
Reply with a brief acknowledgement if work remains; the watchdog will send the actual
continue instruction in the next turn. If no work remains … call stop_watchdog as your final action.
```

催促拆成两段式：检查回合禁工具，AI 回一句文字表示还有活，watchdog 随即发真正的继续消息开工作回合。

**坏点立刻暴露**：模型用「我干完了」这种完成声明回一句文字——按「有文字 = 还有活」的映射，这就是「还有活」，于是白跑一轮继续消息，还把已经交付的最终答案又总结了一遍。

## 第 4 代：把映射明写出来（`c816599`）

```
… Any text reply is read as "work remains" and starts another work turn, so only reply briefly
if work is left, and never restate or summarize an answer you already gave. …
```

核心思路：**模型猜不到的规则要明说**。「有文字 = 还有活」这条映射不是显然的，写出来还不够，还要禁止复述已经交付的回答。测试同步加了断言（`tests/decision-card.test.ts`：「a 'done' reply is not read as done」）。

## 第 5 代：协议换代（`bd1298e`，break）

信号从文字改成工具调用：`stop_watchdog` 重命名为 `watchdog_decide(decision, note)`。

**为什么非要换**：文字通道把两个用途挤在一起——模型把文字当**交付物**认真写，watchdog 把同一段文字当**布尔信号**，写完就折叠掉。模型写得越认真，删得越干净。而且模型想接着干活时没有任何正当工具可调，只能去撞被拦截的工具，撞不明白就按唯一的出口停下。

换代后信号只有一条路：`decision: "continue" | "done" | "wait_user"`，`note` 只上卡片不参与判定。**只回文字、不调工具 = `empty`**：写卡片、发折叠标记、不发继续、重新倒计时，照样扣 `max` 预算——**不 fallback，只面向会调工具的模型**。

**Session 实证（换代初期）**：`…Projects--/2026-09-25T08-22-49-….jsonl`，deepseek-v4.1-flash，thinking=high。08:44:56 的自动 prompt 发出后，模型 5 秒内直接调 `stop_watchdog` 结束；08:55、09:03、09:07 三次都是「一条 prompt → 直接调工具」。换代前（同 session 早期用旧 prompt）flash 模型只回文字、不调工具——「认为已经同意了」的那个问题，在换代后变成 `empty` 结果被兜住，不再白跑。

配套文案（`src/constants.ts:36`）：

> Do not answer with text — a check turn that calls nothing is treated as no answer and the countdown starts over.

明说「回文字等于没回答，倒计时重来」，而不是含糊的「文字表示还有活」。

## 第 6 代：模型不知道检查已结束（`1b0c687` + `0623401`）

**实测**（CHANGELOG Unreleased 有记录）：模型错过回合边界，在工作回合里再调 `watchdog_decide(continue)`，拿回一句「没有检查开着」，于是以为仍在检查回合、把刚交付过的回答重写一遍——一轮里 2,115 字的报告 → 检查 → `continue` → 2,706 字的改版报告。

**补法（三处文案）**：

- 继续消息开头声明「Your watchdog check is over and this is a normal work turn」——检查回合是插件进程内的状态，模型看不到，必须由消息自己说。
- 决策提示声明「restating, expanding or re-formatting it is not work」——已经写出的回答就算交付过了。
- 退回文案从「No watchdog check is open」改成「The watchdog check is already answered and closed」——前者会让模型以为整次检查消失了，是措辞影响模型心智模型的好例子。

## 收束：现在的 prompt（`src/constants.ts:4-12` + `:32-40`）

最终形态是两条消息各管一件事：

- **决策消息**（检查回合）：只走 `watchdog_decide`，回文字 = 没回答，上一回合自己结束不算被中断。
- **继续消息**（工作回合）：开头声明检查已结束，等待用户决策时不改代码、不复述，没活就调 `done`。

## 折叠上下文：从回滚到折叠

这条线的演进比 prompt 简单但更狠：**beta 回滚（opt-in）→ 默认开启的折叠**（`7b60692`）。

早期回滚用 `navigateTree` 移动分支，配套了一整套跳板 / 重试 / 退避 / 尾部校验（`71c014d`、`d47aecf`、`9a65768`、`6fa1581` 一串 fix 都是修它的）。后来整个删掉，换成非破坏性的折叠：**只改发给模型的请求视图，会话文件永不改写**。

现在的折叠（`src/fold.ts`）四个关键设计：

1. **区间**：决策交换是从决策消息开始的连续段，含检查回合里的 assistant / toolResult / 被拦截的工具对。
2. **只折叠可证明已结束的**：必须先碰到同 `exchangeId` 的终点标记（`:continuation` 或 `:fold`）才折叠；碰到真实用户消息、摘要或列表末尾而没有标记，就什么都不折——fail closed，宁可浪费也不误删模型还要回答的决策提示。
3. **主动收尾是镜像方向**：AI 在工作回合末尾直接调 `watchdog_decide` 时，区间是**结束**于标记的那段——任务已完成的「All done」总结在之后每次请求里回放，只会诱导模型复述。
4. **纯函数**：关联只靠消息自身的 `customType` + `details.exchangeId`（主动收尾加 `toolCallId`），跨 resume/reload/分支稳定。

## 复盘：整条演进线的规律

1. **模型猜不到的规则要明说**——「文字 = 还有活」「检查已结束」「复述不是工作」，每一句都是翻车后补的。
2. **一个通道只装一个用途**——文字当信号、又当交付物，是这个插件最大的坑；换成工具调用后信号才干净。
3. **措辞影响心智模型**——「没有检查开着」和「检查已经答过了」是同一个事实的两种说法，后者才不会让模型以为整次检查消失。
