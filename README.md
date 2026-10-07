# pi-extension-watchdog

pi 插件：自动继续监控。AI 停下后自动替你催它继续，直到任务真正完成——你不用守着手动敲「继续」。

**watchdog（看门狗）**：源自硬件领域的一个词，指一个定时检查「程序还活着吗、卡住了吗」的机制。在本插件里，它的职责是：AI 停止输出后开始倒计时，倒计时结束还不动就代你发一条催促消息。

## 截图
![alt text](img/img1.png)
![alt text](img/img2.png)

上下文折叠（默认开启）：决策回合的交换不进上下文，只留继续消息，节约上下文：
![alt text](img/img4.webp)
![alt text](img/img3.png)

（发送的文本或者提示文字可能会随着版本变化而变化）

## 用户故事

### 故事 1：挂机等 AI 跑完，不用手动敲「继续」

AI 有时会因为网络抖动、或「自以为任务完成」而中途停下。watchdog 会先发一条**决策检查**（这一回合禁止干活）：AI 只能调 `watchdog_decide` 回答（`continue` / `done` / `wait_user`），答 `continue` 时 watchdog 随即发出真正的继续指令，`done` / `wait_user` 则停止监控。它既可以在决策检查里回答，也可以不等倒计时、在工作回合末尾直接调 `watchdog_decide(decision="done")` 收尾。

```
/watchdog                       # 空闲 60s 催一次，默认文案，最多检查 50 次
/watchdog timeout=30            # 空闲 30s 催一次
/watchdog timeout=30 message=继续    # 追加指令：触发行 + "Task instruction: 继续"
/watchdog timeout=30 max=100    # 卡死保险上限提到 100 次
```

防呆细节：

- 新会话里 AI 还没开始干活时不倒计时（避免一启动就空催）。
- `/resume` 恢复旧会话（或 `/fork` `/clone` 恢复旧树点）后，即使设了 `PI_WATCHDOG` 也不立即倒计时：历史消息不算活，没有实际操作就不开定时器，AI 首次跑完一轮后才开始；手动 `/watchdog` 启动不受影响。
- 你正在输入或正在按键操作（选命令、翻历史等）时倒计时暂停，你停下后恢复——防止你话说到一半消息就发出去了。
- 你按 `Esc` 中止 AI 的那一轮，watchdog 不会马上又催它继续（状态栏 `⏱⏹`）：这一次空闲不再倒计时，等你发下一条消息、AI 重新开始跑之后恢复正常。
- 决策检查本身也可能失败：provider 报错（网络抖动、限流、超时），或者 provider 干净地结束了流却一个字段都没给（空回复：没有 text、没有 tool call、零 token）。两种都算「这次检查没拿到答案」：不发继续消息，重新开始倒计时（状态栏照常在数），到点再发下一条检查。所谓「重试」就是下一条检查，它同样要从 `max` 预算里扣一次，所以连续失败会照样在 `max` 次后按「催不动」停下。
- 倒计时归零那一刻正好不空闲（AI 又跑起来了，或 pi 正在压缩上下文）：这次不算催促、也不作废，等会话空闲后重新开始一整段倒计时。压缩上下文不会发 `agent_settled`，所以单靠「AI 跑完会重装计时器」会漏掉这一种，现在由每秒一次的 ticker 兜住。

监控停止只有一个入口：`/watchdog stop`，任何模式下都是彻底停止。

### 故事 2：长任务链，AI 多次「自以为完成」，监控别死掉

普通模式下，AI 一调 `watchdog_decide` 监控就没了；但长任务链里 AI 常常阶段性收尾、后面还有活，监控不该这么快退场。用 `mode=keep` 启动**常驻模式**：AI 调 `watchdog_decide` 只是**临时挂起**（状态栏 `⏱⏸`），你发下一条消息时监控自动恢复（计数清零，参数不变）。

```
/watchdog timeout=5 mode=keep   # 常驻模式，空闲 5s 催促
```

常驻模式和普通模式的区别只在退出路径：

- AI 调 `watchdog_decide` → 挂起，等你下一个消息自动唤醒；
- 你执行 `/watchdog stop` → 彻底停止，不会被消息唤醒；
- 达到 `max` 上限 → 彻底停止（说明催了这么多次仍无进展，已彻底卡死，恢复没有意义）。

### 故事 3：sub-agent 无人值守

sub-agent 是你在脚本或 tmux 里另起的 pi 进程，旁边没有人随时敲命令，所以需要开机即自动监控。做法是在启动 pi 前设置环境变量 `PI_WATCHDOG`，语法与 `/watchdog` 参数完全一致，session 启动即自动开始监控：

```bash
PI_WATCHDOG=1                                   # 默认参数
PI_WATCHDOG="timeout=30 max=100"                # 空闲 30s，最多催 100 次
PI_WATCHDOG="timeout=5 mode=keep"               # 常驻模式

# 例：tmux 里起一个自带 watchdog 的 sub-agent
PI_WATCHDOG="timeout=30 max=100" tmux new-session -d -s work pi
```

环境变量随子进程继承，tmux/脚本里启动的 pi 都会生效。格式非法时会明确提示且不启动监控，不会静默失效。

### 完成信号：PI_WATCHDOG_ON_STOP

父进程往往需要知道 sub-agent 何时干完了活。设置 `PI_WATCHDOG_ON_STOP` 后，AI 调用 `watchdog_decide` 时会执行该 shell 命令（`sh -c`，非阻塞，进程分离）：

```bash
# 例：写 exit 码文件并通知 tmux 等待方
PI_WATCHDOG="timeout=5 mode=keep" \
PI_WATCHDOG_ON_STOP="echo 0 > /tmp/pw-exit && tmux -L pi-sub wait-for -S done" \
  tmux new-session -d -s work pi
```

注意：`mode=keep` 下 watchdog_decide 只是挂起监控（新消息可恢复），钩子仍会在挂起动作本身时触发一次。

## 命令一览

```
/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]
/watchdog stop      彻底停止（任何模式）
/watchdog status    查看状态
```

参数只有一个语法：`key=value`。命令与环境变量（`PI_WATCHDOG`）共用同一个解析器，没有位置参数歧义、没有额外子命令。

## 工作原理

AI 停止输出、进入空闲后开始倒计时；倒计时期间 AI 再次运行（或你发消息、正在输入、正在按键操作）则自动暂停/取消；倒计时归零仍空闲，就发起一次**决策检查**：先发一条禁止干活的决策消息（除 `watchdog_decide` 外的工具全被拦截），AI 只能调 `watchdog_decide` 回答——`continue`（还有活）、`done`（干完了）、`wait_user`（在等你拍板）。答 `continue` 时 watchdog 随即发出真正的**继续消息**触发新一轮工作；答 `done` / `wait_user` 时监控停止。如此循环，直到你或 AI 主动停止。

一次检查没拿到答案时（provider 报错、请求超时，provider 什么都没给的空回复，或者干脆没调 `watchdog_decide` 只回了一段文字），watchdog **不**发继续消息、也不当场补发，而是重新开始倒计时；下一次倒计时到点发出的检查就是重试，它同样消耗一次 `max` 名额，所以连续失败也会在 `max` 次后按「催不动」停下。倒计时归零时如果会话正忙（AI 在跑，或 pi 在压缩上下文），这次就整个作废并重新计时，等空闲后再说。

你按 `Esc` 主动中止 AI 的那一轮是例外：`Esc` 是你明确说“停”，watchdog 就不再催。这一次空闲不开始倒计时（状态栏 `⏱⏹`）；等你发下一条消息、AI 重新开始跑后，恢复正常倒计时。如果 `Esc` 正好按在**决策回合**上（倒计时已归零、正在做继续检查），这次检查直接作废：不发继续消息、按 `superseded` 折叠掉，不会触发新一轮工作。

### 跨扩展状态同步

`agent_settled` 只表示 Pi 当前一轮结束，无法表达 watchdog 倒计时后还会继续发消息。为让 tab 标题、通知等状态集成避免提前显示“完成”，watchdog 会通过 Pi 的共享事件总线发布生命周期真值：

- `watchdog:state`：状态变化时广播；消费方以载荷中的 `running` 判断 watchdog 是否仍会续跑。
- `watchdog:state:query`：消费方在启动或 reload 后查询；watchdog 会立即重新广播当前状态，避免依赖扩展加载顺序。

常驻模式下调用 `watchdog_decide` 会发布 `running: false, suspended: true`，表示当前任务已经结束、正在等待下一条真人消息；真人消息恢复监控后重新发布 `running: true`。

你按 `Esc` 中止一轮后，会广播 `interrupted: true`，并在你发下一条真实消息时恢复为 `false`；此时 `running` 仍为 `true`，表示 watchdog 依然开启，只是这一次空闲不再催促。

一次催促由两条消息组成：

- **决策消息**：在 TUI 时间线里只占一行折叠提示——`⏱ watchdog: Sending decision message · click to expand`（`watchdog:` 前缀标明来源插件），点击（或 `ctrl+o`）展开可看发给模型的决策提示全文。它只是视图层可见，发给模型的请求里会被折叠掉（见文末），所以不进上下文。这一回合**禁止干活**——除 `watchdog_decide` 外的工具调用全被拦截，AI 只能调 `watchdog_decide`：
  - `decision: "continue"` = 还有活，下一回合接着干；
  - `decision: "done"` = 任务完成；
  - `decision: "wait_user"` = 在等你拍板。

  文字回答不再算答案（`decisionOutcome` 只读工具调用）：只写文字、没调工具的检查落成 `empty`——写卡片、发折叠标记、不发继续消息、重新倒计时，并且照样扣一次 `max` 名额。这么设计是因为旧协议里「文字 = 还有活」让模型把真正的交付物写进了会被折叠掉的通道，写得越认真删得越干净，而且它想接着干活时没有任何正当工具可调，只能去撞被拦截的工具、撞不明白就按唯一出口停止。

  决策提示还明说两件事（都是实测撞出来的）：**上一回合自己结束不算被中断，已经写出来的回答就算交付过了**，重写 / 扩写 / 换排版都不算「还有活」——否则模型会因为「我的报告好像没发出去」而答 `continue`，再把同一份报告写一遍（长在折叠区间**之外**，永久留在上下文里）。

  每次检查的结果以 `pi-watchdog:decision` 的 `appendEntry` 存进会话历史（继续 / AI 主动停止 / 用户接管作废 / 检查失败 / 没调工具 + `note` 或错误原文，`note` 截断 `DECISION_NOTE_MAX_CHARS`＝200 字符），它在时间线上占一行折叠摘要——`⏱ watchdog: still working · click to expand` / `⏱ watchdog: finished — stopped on purpose` / `⏱ watchdog: waiting on you — reply to resume` / `⏱ watchdog: superseded` / `⏱ watchdog: check failed, will retry` / `⏱ watchdog: no watchdog_decide call from model`，点击展开就是 AI 传给 `note` 的那句短话（失败那张是 provider 报错原文，没调工具那张是一句说明）。它不进模型上下文。常驻模式下 AI 主动停止时会多标一句 `· monitoring paused`。

  先调 `watchdog_decide` 的那次检查没有 note 可看：那一轮的工具调用之后没有后续输出，所以没有短话可存（`superseded` 同理，它的含义是整张卡作废）。这种卡片只显示结果；`failed` 那张显示的是报错原文，`empty` 那张显示的是那句「没调工具」以及它为什么算没答。

  `watchdog_decide` 不只在决策回合可调：AI 真正完工（或只在等你决策）时，可以不等倒计时、在工作回合末尾直接调用它（`decision: "done"` 或 `"wait_user"`；在工作回合里调 `continue` 会被当成错误退回并提醒它继续干活），省掉一次「干等 timeout + 空决策往返」。这时监控同样停止（常驻模式下则挂起）。这条路径没有决策回合，也就没有前两类卡片可看，所以它单独写一张结果卡片——`⏱ watchdog: stopped on purpose · monitoring paused · no check`（后两截按实际情况出现：普通模式没有 `monitoring paused`，两者拼在一起时才最全）。卡片只说明「谁停的、为什么没有检查回合」，没有可展开的回复，和检查里判定停止的那张一样。
- **继续消息**：决策结果为「继续」时才发出，是真正触发工作回合的那条。固定触发行 + 可选追加指令：
  > [Automated, not user input] Your watchdog check is over and this is a normal work turn with every tool available — you are not answering a check now. If work remains, continue working (no reply needed). If waiting on a user decision, don't change code — state what you need in one line, don't restate an answer you already delivered, then call watchdog_decide with decision "wait_user" as your final action. If no work remains and no decision is pending, call watchdog_decide with decision "done" to end the turn.

  开头那句「check is over」是实测补上的：检查是否还开着这个状态**只存在于提示词里**（`decisionWindow` 是插件进程内的状态，模型看不到）。错过它的模型会在工作回合里再次调 `watchdog_decide(decision="continue")`，拿回一句「已经答过了」，然后以为还在检查回合、把刚交付过的回答再写一遍。这句话让回合边界在带内可见。

  它按「AI 为什么停下」分三种情况给出对应动作：还有活就继续干（无需回复）；在等用户决策就不改代码，一行说明需要什么后用 `watchdog_decide(decision="wait_user")` 收尾（不要复述已经交付过的答案）；没活也没待决策就调 `watchdog_decide(decision="done")` 结束回合。开头的 `[Automated, not user input]` 前缀让 AI 知道这不是真用户发言，不会把它当成新的用户指令。
- **追加指令**：可选。`message=` 设置的文案不会替换触发行，而是作为 `Task instruction` 追加在继续消息之后，保证自定义文案不会丢失触发行「继续干活 / 等决策时说明需求 / 主动停止」的核心语义。

### TUI 上的痕迹

一次检查在时间线上占**两行可展开的摘要**：一行是问题（发给模型的提示），一行是答案（AI 传给 `note` 的那句短话；检查失败时是 provider 的报错，没调工具时是一句说明）。

- 发起检查时不发 `ui.notify`（info 通知在 pi 里是**永久**时间线行，不是临时 toast）——检查次数由那两行摘要与状态栏体现。
- 结尾那行只有不超时、真正收到回复的检查才有（未超时、被用户接管 / `Esc` 作废的检查也只落一行）；两种摘要的展开状态各自记在 `src/expanded.ts`，每开新会话时清空。
- `watchdog_decide` 的调用/结果行被隐藏（`renderShell: "self"` + 渲染零行的空 `renderCall`/`renderResult`）；工具本身照常注册、照常进模型上下文。AI 主动收尾（不在决策回合里调它）时，时间线上的唯一痕迹是那张 `· no check` 的结果卡片，状态栏随之清空或转成 `⏱⏸`；这次收尾的文字与工具往返会被折叠掉，不留在后续请求里。
- `watchdog_decide` **不再用 `ctx.abort()` 结束回合**，改用工具结果上的 `terminate: true`（pi 在整批工具都带该标记时跳过后续模型调用）。abort 会在已落盘的 assistant 行后面再补一条空的 `error` 行，TUI 会画成红字、还会被检查误读成 provider 报错：现在这条路整个不存在。差异只有一处值得知道：模型在工具调用**之前**已经流出的收尾文字会留在会话里（abort 本来就截不住它），而它仍落在主动收尾的折叠区间内，代价为零。另外，用户在检查回合里发的消息也不再把 run 打断并退回编辑器，而是由模型在同一轮里回答。

状态栏实时显示（倒计时秒数、已催促次数会随实际情况变化）：

| 图标 | 含义 |
|------|------|
| `⏱23s 2/50` | 倒计时中，已催 2 次，上限 50 次 |
| `⏱▶` | 消息已发出，等 AI 空闲 |
| `⏱✍` | 你在输入/操作，倒计时暂停中 |
| `⏱⏹` | 你按 `Esc` 中止了上一轮，本次空闲不再催促（发下一条消息后恢复） |
| `⏱⏸` | 常驻模式（见故事 2）下被 `watchdog_decide` 挂起中 |

### 额外 token 开销：不多，按需开启

watchdog 不是零成本的，开启后有三处额外开销，都是小头，但会随催促次数累积：

| 开销来源 | 大小 | 说明 |
|---------|------|------|
| 决策回合 | 每次催促多一次模型请求 | 决策消息很短、模型只回一句 `watchdog_decide` 调用；这一回合**不干活**，是上下文折叠得以成立的前提 |
| 每次催促 | 继续消息约 65 token + 你设置的追加指令 | 折叠后只有这条继续消息留在上下文末尾，AI 的回应也随之留下 |
| AI 收尾 | 一次工具调用往返 | `watchdog_decide` 的调用和返回（一个词 `OK.`）；无论来自决策回合还是主动收尾，这段往返都会被折叠掉，不再累积 |
| 工具定义 | 每次请求重复发送 | 注册后随本会话所有请求发出：一段简短描述（约 100 token，含三个取值与 note 说明） + `promptSnippet` / `promptGuidelines` 各一两行 + 参数结构 |

不算在开销里的：AI 被催促后继续干活的正常消耗——那是你本来就要它干的活，watchdog 只是替你敲了「继续」。挂机等待期间 watchdog 只在本地倒计时（改状态栏、看输入），不发任何请求；它唯一产生的就是那条催促消息。

按需使用的建议：只在要挂机的会话里 `/watchdog` 启动，用完 `/watchdog stop`；没启动监控的会话零开销（工具不注册、无催促）。想更省：调大 `timeout` 减少催促次数。**上下文折叠默认开启**，决策交换与收尾往返都不会留在上下文（见文末）。对缓存与成本机制的详细分析见「给 AI 的接口 → 缓存、token 与上下文占用」。


## 给 AI 的接口

插件注册 `watchdog_decide` 工具供 AI 主动退出循环：

```ts
const TOOL_NAME = "watchdog_decide";
pi.registerTool({
    name: TOOL_NAME,
    label: "Watchdog decide",
    description: TOOL_DESCRIPTION,          // 两个用法：回答检查 / 主动收尾
    promptSnippet: TOOL_PROMPT_SNIPPET,     // 系统提示 tools 段的一行
    promptGuidelines: TOOL_PROMPT_GUIDELINES, // 系统提示 Guidelines 段两条
    parameters: Type.Object({
        decision: Type.Union([
            Type.Literal("continue"),
            Type.Literal("done"),
            Type.Literal("wait_user"),
        ]),
        note: Type.Optional(Type.String()),
    }),
    ...
}
```

参数约束（`decision` 三选一必填 + `note` 可选）由 pi 在 `execute` 前用 schema 校验，`note` 的「一行、不超 100 字符」写进了参数描述，代码侧另留 200 字符的兵底截断（`DECISION_NOTE_MAX_CHARS`）。

### 缓存、token 与上下文占用

工具本身只需上面那段描述即可正确使用；下面是监控对 prompt cache、token 消耗和上下文占用的影响，写给维护者和想理解成本机制的读者：

- **工具定义按需注入**：`watchdog_decide` 在监控首次启动时才注册，从未启动过监控的会话里，请求中根本没有这个工具，不占 token。给 AI 看的 description 也尽量压短——工具描述会随每次请求重复发送，属于常驻开销。
- **参数描述只写一次的事**：`note` 的「一行、不超 100 字符、不要放交付物」写在参数描述里，模型每次请求都看得到，但只在真正调工具时才付输出成本；`decision` 的三个取值同时出现在 description、`promptSnippet` 和 `promptGuidelines` 里，三处必须一致，否则模型学到的答案和你要的对不上。
- **描述短、触发行长的分工**：description 短，触发行长。两者都会反复进请求，但计费不同：description 是常驻开销，每次请求都按字节收费，所以只留一两句话——何时能调、调完立即结束回合。触发行按触发事件收费，只出现在继续消息里；它是 AI 学会用该工具的完整来源，尤其在中途开启的会话里，没有它 AI 完工后不会主动调用，所以要写长。把触发行塞进 description，等于每次请求都为它付费；只留 description 不写触发行，AI 又不知道如何收尾。
- **注册后永不移出**：tools 定义位于请求前缀（system prompt + tools）中，中途增删一个工具，prompt cache（服务端对完全相同前缀的缓存：命中部分计费更低、响应更快）就会从改动处整体失效。首次注册只损失一次缓存，之后即使 `/watchdog stop` 工具也保持注册，前缀字节级缓存稳定。
- **催促只追加、不改动前缀**：继续消息追加在上下文末尾，前缀不动，缓存不受影响；决策消息与收尾往返会被折叠掉，不再累积。
- **用终止性工具结果结束回合，不截断已生成的文字**：AI 调用 `watchdog_decide(decision="done"|"wait_user")`（或答 `continue`）后，pi 在这一批工具结束时跳过后续模型调用，工具调用之后的内容不再生成；工具调用**之前**已流出的文字保留在会话里（abort 也截不住它），并且会被折叠掉。
- **上下文折叠（默认开启）**：每次发给模型之前，把「决策消息 + AI 的回复」整段移除，只留下继续消息。「决策回合不干活」保证这段交换是一个封闭区间：只删后缀、不动中段，前缀缓存不被破坏，也不会产生未配对的 tool_use。详见文末「上下文折叠（默认开启）」。

### 中途开启 watchdog 会发生什么

`/watchdog` 支持在会话中途开启。相比启动时就开启，中途开启会多出一笔成本，首次注册会击穿一次 prompt cache：

中途开启时，上下文往往已经很长。tools 列表一变，下一次请求的前缀缓存就要整段重算；上下文越长，这次损失越大。

如果是启动时就注册：前缀从一开始稳定，但不用监控的会话也要一直承担工具定义的 token，因为工具描述会随每次请求重复发送。

`/watchdog stop` 时移除工具，下次再注册：每次增删都会造成缓存失效，反复启停损失更大。

因此插件接受：开启时一次性生效，之后永不移出。

## 安装

推荐通过 pi 的包管理安装（会自动进入 [pi.dev/packages](https://pi.dev/packages) 包画廊索引）：

```bash
# npm 渠道
pi install npm:pi-extension-watchdog

# 或 git 渠道（pi 会自动装依赖；默认跟踪默认分支，pi update 时随之更新）
pi install git:github.com/GreenHatHG/pi-extension-watchdog

# 想锁定版本也可以锚定 tag（之后需手动 pi install <...>@新tag 才会升级）
pi install git:github.com/GreenHatHG/pi-extension-watchdog@v1.1.0

# 不安装、临时体验当前目录的包
pi -e .
```

装完在 pi 里用 `/reload` 热加载（不用重启 pi 就能让插件生效）。已安装的包可用 `pi list` 查看、`pi remove npm:pi-extension-watchdog` 卸载。

不想装包管理，也可以手动拷贝单文件：

```bash
# 全局：所有项目生效
cp index.ts ~/.pi/agent/extensions/watchdog.ts

# 或项目级：仅当前项目生效
mkdir -p .pi/extensions && cp index.ts .pi/extensions/watchdog.ts
```

本地开发：`pnpm test`（vitest；开发时用 `pnpm run test:watch` 自动重跑），`pnpm typecheck` 检查类型。

## 上下文折叠（默认开启）

**上下文折叠**指：每次发给模型之前，把决策回合产生的「决策消息 + AI 的回答」从请求里移除，最终只留下那条继续消息；AI 主动收尾时，把那一次收尾（收尾文字 + `watchdog_decide` 调用与返回）整段移除。它只影响本次请求的视图，不改写会话记录，所以无需任何开关，也不用 `/tree` 回退。

折叠按 `exchangeId` 关联一次决策交换：

- 决策消息（`pi-watchdog:nudge`）是区间起点（同时会写一条不进上下文的 `appendEntry` marker 做持久关联）；
- **继续消息**（`pi-watchdog:continuation`）是终点，本身保留——后续工作回合就追加在它后面；
- AI 调 `watchdog_decide` 时另写一条**停止标记**（`pi-watchdog:fold`），连同整段交换一起删除；
- 决策回合里的文字**不再被剥离**：文字不是信号（watchdog 只读 `watchdog_decide` 调用），它跟着交换一起折叠掉，同时完整留在会话文件里——那是用户能看到的「模型为什么这么答」的唯一痕迹。
- **主动收尾**（AI 不等催促、在工作回合末尾直接调 `watchdog_decide`）折叠的是另一端：终点标记（`pi-watchdog:stopped`）在回合结束后落盘，标出它夹带的那次工具调用 `toolCallId`；折叠时从携带该调用的 assistant 消息删到标记本身，把「全部干完了」这类收尾陈述从后续每次请求里去掉。标记的定位不靠保存顺序，所以 AI 在工具调用之后又写了一句收尾文字也一并落在区间里；找不到那次调用（已被压缩）就不删，宁可不折叠也不误删；
- 被拦截的工具调用与其返回结果成对落在区间里，一起删除，不会留下未配对的 tool_use；
- 区间内出现真实用户消息、其它插件的 custom 消息、或另一个交换 → **fail closed**，原样保留，绝不误删；
- 决策回合还没结束（找不到终点标记）→ 同样保留，否则模型将看不到决策提示词；
- 用户在决策回合内插话，或回合没正常回到空闲，或你按 `Esc` 中止了决策回合 → 写 `superseded` 终点标记，整段交换删除：本次检查作废，由你的消息接管（watchdog 不丢锁，回合结束后重新倒计时）。

为什么能安全地删：中段删除会让其后所有字节前移错位，prompt cache 从改动点整段失效。而**决策回合不干活**，它的交换始终是一段封闭区间——折叠后前缀字节不变，工作回合的 token 也缓存在它们的最终位置上。结束这一轮靠的是工具结果上的 `terminate: true`（pi 跳过后续模型调用），不产生额外消息行，也不改写已有行。

折叠是**视图层**操作：会话文件（append-only）里仍保留这些协议条目，`/tree` 里也看得到，只是永远不会发给模型。决策消息的 `display:true` 也让它出现在 `/tree` 全量视图与会话导出里。若扩展未加载，折叠不会生效，决策交换会重新进入上下文，`display:true` 的决策消息还会连提示全文一起上屏——这是已知边界。print / JSON 模式下没有 TUI，继续消息会以 `pi-watchdog:continuation` custom 消息出现在输出流里，这是给消费方的机器可读标记。

折叠只作用于发给模型的消息数组；可见的**决策提示**就是决策消息本身，所以它被折叠掉（不进上下文）的同时照常在 TUI 里显示。而 **`pi-watchdog:decision` 结果记录**是 `appendEntry` 写的 `CustomEntry`，根本不在这个数组里，既不触发 fail-closed 也不受折叠影响。

## 更新日志

参见 [CHANGELOG.md](./CHANGELOG.md)。

## 项目支持

<table>
<tbody>
<tr>
<td align="center" width="33%">
<a href="https://linux.do"><img src="https://cdn3.ldstatic.com/original/4X/d/1/4/d146c68151340881c884d95e0da4acdf369258c6.png" alt="LINUX DO" width="120"></a>
<br><sub>社区支持</sub>
</td>
</tr>
</tbody>
</table>