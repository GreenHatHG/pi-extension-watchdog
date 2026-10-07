# pi-watchdog 是怎么跑起来的

> **⚠️ 本文已过期（停在 `a9a42d1`）**：文中的行号、决策提示原文、以及第 3–5 节对「回复文字被剥离」的描述，对应的都是 `stop_watchdog` + 文字信号那一代协议。当前工作区已改成 `watchdog_decide(decision, note)`，信号只走工具调用，文字不再被剥离，`DecisionWindow.replyText` / `sawToolCall` / `DECISION_REPLY_MAX_CHARS` 已删除。**结束回合也从 `ctx.abort()` 换成了工具结果上的 `terminate: true`**：abort 会在已落盘的 tool-call 行后面再落一条空 `error` 行（被 `runError` 读成 provider 报错、被当成用户 `Esc`），而 terminate 只是让 pi 跳过后续模型调用，不产生任何多余行——于是 `stopAbortPending` / `selfAbortPending` / 幻影行改写 / `isEmptyAssistantContent` 整套善后代码都被删除（详见 `CHANGELOG.md` Unreleased）。第 1、2 节的时序框架仍然成立，第 4 节之后请以源码与 `README.md` 为准。

> 按 `a9a42d1` 这个版本拆解。所有行号都能在仓库里打开核对。

## 本文证据分级

读之前先约定两件事，免得后面把「猜的」当成「验过的」：

- 凡是写了 `文件:行号` 的，你打开那个文件就能看到，可以直接核对。
- 凡是标了 **【设计推理】** 的，是作者写在代码注释或 `README.md` 里的论证，仓库里**没有**实测数据。它可能是对的，但这篇文章不为它背书。

全仓库只有 1483 行 TypeScript，其中 `src/watchdog.ts` 一个文件占 1021 行（`wc -l src/*.ts` 可查）。下面每节都尽量贴回那一行。

---

## 一、它替你做的那一件事

### 问题

`README.md:3` 把问题写得很直白：AI 有时因为网络抖动、或者「自以为任务完成」而中途停下，你就得盯着屏幕，手动敲一句「继续」。

watchdog 要做的事只有一件：**AI 不说话了，就替你敲这句「继续」。**

### 一句话心智模型

```
空闲 → 倒计时 → 决策检查 → 继续消息 → 工作回合 → 空闲 → …
                     ↓
              （没拿到答案：倒计时重来，不发继续）
```

日常只需要记一句话：

> **AI 空闲够久，就替用户发一条「继续」；发之前先花一个回合问 AI 一句「还有活吗」。**

后面所有的复杂度——折叠、五种消息、状态机——都是从这一句话长出来的。这里先不展开，第二节马上讲完整时序。

### 你会看见什么

这套机制唯一天天露脸的界面是状态栏（表格抄自 `README.md:140-146`，图标由 `renderStatus()` 在 `src/watchdog.ts:479` 画出来）：

| 图标 | 含义 |
|------|------|
| `⏱23s 2/50` | 倒计时中，还剩 23 秒，已催 2 次，上限 50 次 |
| `⏱▶` | 消息已发出，等 AI 空闲 |
| `⏱✍` | 你在输入 / 正在操作，倒计时暂停中 |
| `⏱⏹` | 你按了 `Esc` 中止上一轮，本次空闲不再催 |
| `⏱⏸` | 常驻模式下被 `watchdog_decide` 挂起中 |

左边那个 `⏱` 是它占下的状态栏位置，键名是常量 `STATUS_KEY = "watchdog"`（`src/constants.ts:57`）。

### 一个容易想歪的点

watchdog **不是一个自己跑起来、循环调用 AI 的后台进程**。它自己不发起任何东西，只是往 pi 的几个生命周期钩子上挂函数（全部注册在 `src/watchdog.ts:132-170`，一共 8 个 `pi.on(...)` 加 1 个事件总线监听）。

所以「watchdog 在监控我」这句话的准确版本是：**pi 每次进入「AI 跑完了、没事干了」这个时刻，都会叫醒 watchdog 一次，watchdog 决定要不要开始倒计时。**

---

## 二、一次催促的完整过程

这一节是主干。读完这节，你已经能理解这个插件 80% 的行为。

### 起点：AI 跑完了

pi 在「这一轮彻底结束、不会再有自动重试或排队续跑」时发出 `agent_settled`。watchdog 挂了两个处理函数接它，第一个就是 `onAgentSettled`（注册顺序见 `src/watchdog.ts:163-164`，这个顺序很重要，第五节会讲原因）。

`onAgentSettled` 在 `src/watchdog.ts:291`。它做完结算后，最后一行是 `armCountdown(ctx)`（`src/watchdog.ts:346`）。

### 装一个倒计时

`armCountdown`（`src/watchdog.ts:608`）依次问三个问题，任何一个为真就不装表：

| 问题 | 代码 | 为什么 |
|------|------|--------|
| 上一轮是你按 `Esc` 中止的吗？ | `state.interrupted`（`:610`） | 你已经明确说「停」，不再催 |
| 编辑器里有没发出去的字吗？ | `editorHasText(ctx)`（`:616`） | 你正打字，催了就是打断你 |
| 你刚按过键吗（2 秒内）？ | `userActive()`（`:621`，阈值 `ACTIVITY_GRACE_MS` 在 `src/constants.ts:28`） | 你可能在翻历史、选命令 |

三个都不为真，才真正装表（`src/watchdog.ts:626-631`）：

```ts
state.countdownDeadline = Date.now() + state.timeoutMs;
state.timer = setTimeout(() => {
    state.timer = null;
    void fireNudge(ctx);
}, state.timeoutMs);
renderStatus(ctx);
```

`countdownDeadline` 是倒计时的终点时刻（epoch 毫秒），状态栏上的秒数就是拿它减当前时间算出来的（`src/watchdog.ts:449-451`）。

另外有一个每秒跑一次的 `ticker`（`startTicker`，`src/watchdog.ts:808`），它干两件事：重画状态栏的秒数；以及替你盯着编辑器和键盘，发现你开始打字/按键就把表撤了改成暂停。

### 归零：先确认 AI 真的闲着

倒计时到点，进 `fireNudge`（`src/watchdog.ts:637`）。

第一件事是把 `countdownDeadline` 置空（`:639`）——注意这一行，第 6 节会拿它说事。

然后**再确认一次** `ctx.isIdle()`（`:641`）。为什么不直接发？因为这一秒里世界可能变了：AI 又跑起来了，或者 pi 正在压缩上下文。这时候**不催、也不作废**，只挂一个标记 `state.waitingForIdle = true`（`:644`）就返回，交给 ticker 等空闲了重新装表（`src/watchdog.ts:812-815`）。

再往下还有两道竞态兜底（`:646-657`）：确认你没在打字、没在按键。都过了，才 `sendDecision(ctx)`。

### 决策检查：一个不干活的回合

`sendDecision`（`src/watchdog.ts:667`）先数一次数：

```ts
state.nudgeCount++;
if (state.nudgeCount > state.maxNudges) {
    state.mode = "once";
    teardown(ctx);
    ctx.ui.notify(`watchdog: nudged ${state.maxNudges} times with no progress, auto-stopped`, "warning");
    return false;
}
```

撞了 `max` 上限就彻底收摊（`:669-674`）——这说明催了这么多次还没进展，是真卡死了，再等也没意义。注意它**不管当前是哪种模式**都把 `mode` 改成 `once`，所以常驻模式也照样停。

没撞上限，就建一个 `decisionWindow` 并发出**决策消息**（`src/watchdog.ts:676-687`）：

```ts
const exchangeId = createExchangeId();
decisionWindow = { exchangeId, stopCalled: false };
pi.sendMessage(
    { customType: DECISION_MESSAGE_TYPE, content: DECISION_MESSAGE, display: true, details: { exchangeId } },
    { triggerTurn: true, deliverAs: "steer" },
);
```

这条消息的正文就是 `DECISION_MESSAGE`（`src/constants.ts:21-25`），大意是：

> 【自动消息，不是用户发言】watchdog 检查——这个回合除了 `stop_watchdog`，所有工具都被禁。**任何文字回复都会被理解成「还有活」**，所以只剩活就简短回一句；没活或者你在等用户决策，就把 `stop_watchdog` 当最后一个动作调掉。

这几点都关键，逐个说：

- `triggerTurn: true` —— 这条消息会**开一个新回合**让 AI 回话。这就是「决策回合」。
- `deliverAs: "steer"` —— 在当前回合的工具调用跑完之后、下一次模型请求之前投递。
- `details.exchangeId` —— 一个本次交换专属的编号（`createExchangeId()`，`src/watchdog.ts:755`，形如 `w1a2b3-1`）。它只有一个用途：让后面的折叠认得「这几条消息是同一次检查的」。
- `display: true` —— 时间线上会显示一行折叠提示。**这一项跟「进不进模型上下文」没关系**，第 3 节会专门澄清。

放进 `try` 里是因为：只有一种情况会同步抛异常——`ctx` 已经过期（会话被替换了）。这时候代码选择**彻底停**而不是硬撑（`src/watchdog.ts:688-695`），并把刚加的计数退回去，因为消息根本没发出去。注释里写了原因：硬撑会留下一个「半开的决策窗口」，下一回合所有工具都会被拦掉。

### 决策回合期间，两件事同时发生

AI 开始回话的同时，watchdog 干两件事：

**第一，把所有工具拦下来。** `onToolCall`（`src/watchdog.ts:213`）只在 `decisionWindow !== null` 时动手：

```ts
if (decisionWindow === null) return;
if (event.toolName === TOOL_NAME) return;
return { block: true, reason: "Watchdog decision turn: every tool except stop_watchdog is blocked. ..." };
```

也就是说这个回合里 AI **除了 `stop_watchdog` 什么也调不动**。这是刻意的，原因在第 4 节。

**第二，把 AI 的回复文字从落盘内容里剥掉。** `onMessageEnd`（`src/watchdog.ts:257`）做两件事：

1. 记下这个回合有没有出现过工具调用（`decisionWindow.sawToolCall = true`，`:279`）——下面分类结果时会用。
2. 如果回复里有文字，先抄一份到 `decisionWindow.replyText`（截断 300 字，`:282-283`），再把文字块从要保存的消息里删掉（`:284-288`）。

```ts
return {
    message: {
        ...event.message,
        content: hasToolCall ? (content as unknown[]).filter((block) => !(isRecord(block) && block.type === "text")) : [],
    } as typeof event.message,
};
```

带 `stop_watchdog` 的时候只删文字块、保留工具调用块——不然工具调用和它的返回结果就不配对了。注释在 `src/watchdog.ts:274-276` 解释了为什么非要删：这句回复马上要被折叠掉，如果它照常落进会话文件，TUI 上就会以原始消息的形式再出现一遍。

### 回合结束：结算

决策回合跑完，走完 `agent_end`（`onAgentEnd`，`src/watchdog.ts:225`，这里先按下不表），再到 `agent_settled`，回到 `onAgentSettled` 的结算段（`src/watchdog.ts:291-353`）。

第一件事是把窗口**取走并立刻置空**（`:292-293`）：

```ts
const window = decisionWindow;
decisionWindow = null;
stopAbortPending = false;
```

注释在 `:292` 说明了原因：`stop_watchdog` 在决策回合里被调用时，它已经把 `running` 置成 false 了，但**还欠一个折叠标记**，所以不能因为「没在跑」就跳过结算。

然后判断这次检查算不算白跑（`:295-299`）：

```ts
const superseded = !ctx.isIdle() || ctx.hasPendingMessages() || window.aborted === true;
const outcome = decisionOutcome(window, superseded);
```

再然后按结果分两条路（`:304-329`）：

| 结果 | 发什么 | 意义 |
|------|--------|------|
| `stop` / `superseded` / 需要重试 | `pi-watchdog:fold`，`display: false`，`triggerTurn: false` | 只留一个「这次检查到此结束」的标记，**不发继续消息** |
| 其它（即 `continue`） | `pi-watchdog:continuation`，`display: true`，`triggerTurn: true`，`deliverAs: "followUp"` | 这才是真正让 AI 继续干活的那条消息 |

继续消息的正文是 `continuationText(state.message)`（`src/constants.ts:12-13`）：一条固定的触发行（`DEFAULT_MESSAGE`，`src/constants.ts:4-9`）加上你可能用 `message=` 追加的一句 `Task instruction:`。它永远**不替换**触发行，只追加。

注意 `deliverAs` 从决策消息的 `steer` 换成了 `followUp`（`:329`）——真干活的这条要等 agent 手上所有工具跑完再投递。

接着写一张历史卡片（`pi.appendEntry`，`src/watchdog.ts:334-342`），它记录本次结果、AI 那句被剥掉的回复、失败时的报错原文。这张卡片**不进模型上下文**（第五节解释原因），只是让你事后能翻。

最后（`:346`）：

```ts
armCountdown(ctx); // Queued turns and failed/empty checks are done, so count down again.
```

**每次结算完都重新装表**，回到本节开头。整个循环就这样转起来。

### 完整一圈

```
AI 停下来
   │  pi 发 agent_settled
   ▼
onAgentSettled ──► armCountdown ──► countdownDeadline + setTimeout
   ▲                                      │ 到点
   │                                      ▼
   │                                 fireNudge ──► 不空闲？waitingForIdle，等 ticker
   │                                      │ 空闲
   │                                      ▼
   │                                 sendDecision ──► 发 nudge 消息（开决策回合）
   │                                      │
   │        ┌── 决策回合（工具全禁，回复文字被剥） ──┐
   │        │                                      │
   │        └────► agent_settled 回来结算 ◄────────┘
   │                     │
   │        ┌────────────┴────────────┐
   │        ▼                         ▼
   │   continue                    stop / superseded / 失败
   │        │                         │
   │   发 continuation            发 :fold，不发继续
   │   （真干活）                  （下一条检查就是重试）
   │        │                         │
   └────────┴─────────────────────────┘
```

### 这次检查也可能「没拿到答案」

上面那张图少画了一种情况：决策回合跑完了，但 watchdog 一个问题都没得到答案。这有两种：

| 情况 | 触发 | `outcome` |
|------|------|-----------|
| provider 报错（网络抖动、限流、超时） | 最后一条 assistant 消息 `stopReason === "error"` | `failed` |
| 空回复 | 流干净地结束了，但没有文字、也没有工具调用 | `empty` |

两种走**同一条路**：写卡片、发 `:fold`、**不发继续消息**、重新开始倒计时。所谓「重试」就是下一次倒计时到点发出的那条检查。判定的时刻在 `agent_settled`，不在 `agent_end`——因为 pi 内部可能自动重试，`agent_end` 会响多次，只有等到「彻底沉降」才能确定没有重试能救回来。

这里含一个反直觉的设计：失败之后**不当场补发**，而是重走一整段倒计时。代价是白等一个 `timeout`，好处是这条重试天然要走 `sendDecision` 的 `nudgeCount++`（`src/watchdog.ts:668`），所以「连续失败会不会绕过 `max` 停止保险」这个问题根本不存在——它照样扣预算。这个改动是 `a9a42d1` 做的，第六节讲为什么。

结果分类的判定函数是 `decisionOutcome`（`src/watchdog.ts:773-779`），五行，**顺序就是优先级**：

```ts
if (window.stopCalled) return "stop";
if (superseded) return "superseded";
if (window.failed === true) return "failed";
if (window.replyText === undefined && window.sawToolCall !== true) return "empty";
return "continue";
```

两条容易写错的地方：

- `failed` 必须排在 `empty` 前面。因为报错的那个回合**同时**也是空的（没文字），顺序反了就会把「网络炸了」误报成「模型没说话」。
- `empty` 的判据是「没文字**且**没有工具调用」。只有工具调用也算答案——那说明 AI 想干活，只是工具被拦了。

### 小结

到这里，主干的每一件事都能对上代码了。剩下几节要回答几个「为什么」：

1. 第 3 节：那五条消息都是什么？
2. 第 4 节：为什么决策回合非要禁止干活？那堆消息又是怎么从发给模型的请求里消失的？
3. 第 5 节：AI 自己叫停时，为什么非要等到回合结束才记账？
4. 第 6 节：什么情况下不催（按 `Esc`、打字、按键、压缩上下文）？
5. 第 7 节：为什么模块级变量会从上一个会话漏到下一个会话？

---

## 全文目录

1. 它替你做的那一件事 ✅
2. 一次催促的完整过程 ✅
3. 五种消息与两条带外通道
4. 上下文折叠：两个方向（附：为什么决策回合禁止干活）
5. AI 主动收尾为什么要等沉降
6. 状态机：相位、keep 三态、`Esc`、暂停
7. 跨会话的模块级状态泄漏
8. 配置面与对外接口（命令 / 环境变量 / 工具 / 事件总线 / TUI 卡片）
9. 已知边界与未核实