# pi-extension-watchdog

pi 插件：自动继续监控。AI 停下后自动替你催它继续，直到任务真正完成——你不用守着手动敲「继续」。

**watchdog（看门狗）**：源自硬件领域的一个词，指一个定时检查「程序还活着吗、卡住了吗」的机制。在本插件里，它的职责是：AI 停止输出后开始倒计时，倒计时结束还不动就代你发一条催促消息。

## 截图
![alt text](img/img1.png)
![alt text](img/img2.png)

PI_WATCHDOG_ROLLBACK上下文回滚（可选，beta），从上下文中去除催促的内容，节约上下文：
![alt text](img/img4.webp)
![alt text](img/img3.png)

（发送的文本或者提示文字可能会随着版本变化而变化）

## 用户故事

### 故事 1：挂机等 AI 跑完，不用手动敲「继续」

AI 有时会因为网络抖动、或「自以为任务完成」而中途停下。watchdog 会自动催它继续；AI 真正完成时，会收到触发行里的提示，主动调用 `stop_watchdog` 工具收尾，监控随之停止。

```
/watchdog                       # 空闲 60s 催一次，默认文案，最多催 50 次
/watchdog timeout=30            # 空闲 30s 催一次
/watchdog timeout=30 message=继续    # 追加指令：触发行 + "Task instruction: 继续"
/watchdog timeout=30 max=100    # 卡死保险上限提到 100 次
```

防呆细节：

- 新会话里 AI 还没开始干活时不倒计时（避免一启动就空催）。
- `/resume` 恢复旧会话（或 `/fork` `/clone` 恢复旧树点）后，即使设了 `PI_WATCHDOG` 也不立即倒计时：历史消息不算活，没有实际操作就不开定时器，AI 首次跑完一轮后才开始；手动 `/watchdog` 启动不受影响。
- 你正在输入或正在按键操作（选命令、翻历史等）时倒计时暂停，你停下后恢复——防止你话说到一半消息就发出去了。

监控停止只有一个入口：`/watchdog stop`，任何模式下都是彻底停止。

### 故事 2：长任务链，AI 多次「自以为完成」，监控别死掉

普通模式下，AI 一调 `stop_watchdog` 监控就没了；但长任务链里 AI 常常阶段性收尾、后面还有活，监控不该这么快退场。用 `mode=keep` 启动**常驻模式**：AI 调 `stop_watchdog` 只是**临时挂起**（状态栏 `⏱⏸`），你发下一条消息时监控自动恢复（计数清零，参数不变）。

```
/watchdog timeout=5 mode=keep   # 常驻模式，空闲 5s 催促
```

常驻模式和普通模式的区别只在退出路径：

- AI 调 `stop_watchdog` → 挂起，等你下一个消息自动唤醒；
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

## 命令一览

```
/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]
/watchdog stop      彻底停止（任何模式）
/watchdog status    查看状态
```

参数只有一个语法：`key=value`。命令与环境变量（`PI_WATCHDOG`）共用同一个解析器，没有位置参数歧义、没有额外子命令。

## 工作原理

AI 停止输出、进入空闲后开始倒计时；倒计时期间 AI 再次运行（或你发消息、正在输入、正在按键操作）则自动暂停/取消；倒计时归零仍空闲，就以你的名义发一条催促消息，触发新一轮。如此循环，直到你或 AI 主动停止。

催促消息由两部分组成：

- **触发行**：固定文案（`message=` 只追加、不替换本行）：

  > [Automated, not user input] If work remains, continue working (no reply needed). If waiting on a user decision, don't change code — state what you need, then call stop_watchdog as your final action. If no work remains and no decision is pending, call stop_watchdog to end the turn.

  它按「AI 为什么停下」分三种情况给出对应动作：还有活就继续干（无需回复）；在等用户决策就不改代码，说明需要什么后以 `stop_watchdog` 收尾；没活也没待决策就调 `stop_watchdog` 结束回合。开头的 `[Automated, not user input]` 前缀让 AI 知道这不是真用户发言，不会把它当成新的用户指令。
- **追加指令**：可选。`message=` 设置的文案不会替换触发行，而是作为 `Task instruction` 追加在其后，保证自定义文案不会丢失触发行「继续干活 / 等决策时说明需求 / 主动停止」的核心语义。

状态栏实时显示（倒计时秒数、已催促次数会随实际情况变化）：

| 图标 | 含义 |
|------|------|
| `⏱23s 2/50` | 倒计时中，已催 2 次，上限 50 次 |
| `⏱▶` | 消息已发出，等 AI 空闲 |
| `⏱✍` | 你在输入/操作，倒计时暂停中 |
| `⏱⏸` | 常驻模式（见故事 2）下被 `stop_watchdog` 挂起中 |

### 额外 token 开销：不多，按需开启

watchdog 不是零成本的，开启后有三处额外开销，都是小头，但会随催促次数累积：

| 开销来源 | 大小 | 说明 |
|---------|------|------|
| 每次催促 | 触发行约 65 token + 你设置的追加指令 | 以用户消息追加在上下文末尾，AI 的回应也随之留下；留在上下文里的内容会随之后的每次请求重复携带 |
| AI 收尾 | 一次工具调用往返 | `stop_watchdog` 的调用和返回（一个词 `OK.`） |
| 工具定义 | 每次请求重复发送 | 注册后随本会话所有请求发出：一句描述（约 17 token） + 空参数结构 |

不算在开销里的：AI 被催促后继续干活的正常消耗——那是你本来就要它干的活，watchdog 只是替你敲了「继续」。挂机等待期间 watchdog 只在本地倒计时（改状态栏、看输入），不发任何请求；它唯一产生的就是那条催促消息。

按需使用的建议：只在要挂机的会话里 `/watchdog` 启动，用完 `/watchdog stop`；没启动监控的会话零开销（工具不注册、无催促）。想更省：调大 `timeout` 减少催促次数；开启 `PI_WATCHDOG_ROLLBACK=1` 让收尾往返不留在上下文（beta 功能，见文末）。对缓存与成本机制的详细分析见「给 AI 的接口 → 缓存、token 与上下文占用」。


## 给 AI 的接口

插件注册 `stop_watchdog` 工具供 AI 主动退出循环：

```ts
const TOOL_NAME = "stop_watchdog";
pi.registerTool({
    name: TOOL_NAME,
    label: "停止自动继续",
    description: "Ends the turn immediately; call only after a watchdog nudge when no work remains.",
    parameters: Type.Object({}),
    ...
}
```

### 缓存、token 与上下文占用

工具本身只需上面一句描述即可正确使用；下面是监控对 prompt cache、token 消耗和上下文占用的影响，写给维护者和想理解成本机制的读者：

- **工具定义按需注入**：`stop_watchdog` 在监控首次启动时才注册，从未启动过监控的会话里，请求中根本没有这个工具，不占 token。给 AI 看的 description 也压缩成一句话——工具描述会随每次请求重复发送，属于常驻开销。
- **描述短、触发行长的分工**：description 短，触发行长。两者都会反复进请求，但计费不同：description 是常驻开销，每次请求都按字节收费，所以只留一句话——何时能调、调完立即结束回合。触发行按触发事件收费，只在真正催促时追加，最近一次还能回滚删除；它也是 AI 学会用该工具的完整来源，尤其在中途开启的会话里，没有它 AI 完工后不会主动调用，所以要写长。把触发行塞进 description，等于每次请求都为它付费；只留 description 不写触发行，AI 又不知道如何收尾。
- **注册后永不移出**：tools 定义位于请求前缀（system prompt + tools）中，中途增删一个工具，prompt cache（服务端对完全相同前缀的缓存：命中部分计费更低、响应更快）就会从改动处整体失效。首次注册只损失一次缓存，之后即使 `/watchdog stop` 工具也保持注册，前缀字节级缓存稳定。
- **催促只追加、不改动**：每次催促在上下文末尾追加一条用户消息，前缀不动，缓存不受影响；代价是上下文变长——每轮催促留下一条用户消息，AI 停止时再留下一对「工具调用 + 工具返回」。
- **停止时立即截断**：AI 调用 `stop_watchdog` 后回合立即中止（等同按 Esc），工具调用之后的收尾文字不再生成，省掉这部分输出 token（abort 前已落盘的文字截不掉）。
- **上下文回滚（beta，可选）**：设 `PI_WATCHDOG_ROLLBACK=1` 后，AI 停止时把「本次催促消息 + AI 的回应」从上下文尾部删掉，「确认停止」的往返不再累积。只删后缀、不动中段：中段删除会让其后所有字节前移错位，缓存整段失效，还会产生没有配对返回结果的 tool_use。详见文末「上下文回滚（可选，beta）」。

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

# 或 git 渠道（锚定 tag，pi 会自动装依赖）
pi install git:github.com/GreenHatHG/pi-extension-watchdog@v1.0.0

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

## 上下文回滚（可选，beta）

> **Beta 声明**：上下文回滚目前还是 beta 功能，可能会出现问题。如有疑虑，可随时用 pi 自带的 `/tree` 命令查看会话树，确认实际保留了哪些消息；必要时在树中选中回滚前的节点即可恢复。

默认关闭。启动 pi 前设置 `PI_WATCHDOG_ROLLBACK=1` 开启。**上下文回滚**指：AI 调 `stop_watchdog` 后，把本次催促消息及 AI 的回应从对话上下文中移除，避免「AI 确认停止、你再确认」这类多余的往返内容一直留在上下文里占空间、干扰后续对话。该设置在会话重载时重新读取。

### 内部命令 watchdog-internal

回滚的实际执行靠一个内部命令 `/watchdog-internal`（它会出现在 `/` 命令补全列表里——pi 的补全列表不会因为命令没写 description 就把它隐藏，也没有提供按命令隐藏或注销的 API；没有待回滚任务时手动调用它，什么也不会发生）。

存在的原因：删除催促交换要用 `navigateTree`（把分支指针移回催促前的位置），而 pi 只有命令 handler 拿到的 ctx 才有这个方法，`agent_settled` 事件回调的 ctx 没有。所以插件走了一道「跳板」：

1. 发送催促前，先记录当时的会话末尾位置（leaf id）和催促全文，作为回滚点；AI 调 `stop_watchdog` 时，把该标记转入待回滚；
2. 回合结束（`agent_settled`）后，扩展通过 `sendUserMessage` 发送 `/watchdog-internal op=rollback target=<leafId>`，pi 把这条以 `/` 开头的消息识别为命令执行，而不是发给 AI 的用户发言；
3. 命令 handler 拿到带 `navigateTree` 的 ctx，完成删除。

执行前有三道保险：

- **一次性消费**：待回滚标记在命令入口即清空，重复调用、无标记调用都是空操作；
- **参数校验**：`target=` 必须与待回滚标记一致，不匹配直接放弃（防误调）；
- **尾部校验**：确认催促之后到当前结尾，只有本次催促的交换——催促消息本身、AI 对它的回复（纯文字/thinking 也允许：反正会随回滚一起删掉，删了无损失）、`stop_watchdog` 的调用与返回。期间混入任何真实用户消息、其他工具调用或其他类型的记录（如压缩记录），都说明 AI 干了真活，放弃回滚、保留现状。

失败处理：发送失败则保留标记，下个回合结束后重试；校验不通过或删除失败则放弃，催促交换留在上下文里——只是多占些空间，不影响正确性。

