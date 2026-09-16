# pi-watchdog (watchdog)

pi 插件：自动继续监控。AI 停下后自动替你催它继续，直到任务真正完成——你不用守着手动敲「继续」。

## 工作原理

AI 停止输出、进入空闲后开始倒计时；倒计时期间 AI 再次运行（或你发消息、正在输入、正在按键操作）则自动暂停/取消；倒计时归零仍空闲，就以你的名义发一条催促消息，触发新一轮。如此循环，直到你或 AI 主动停止。

状态栏实时显示：`⏱23s 2/50`（倒计时中 · 已催 2/50 次）、`⏱▶`（等 AI 空闲）、`⏱✍`（你在输入/操作，暂停中）、`⏱⏸`（常驻模式挂起中）。

## 用户故事

### 故事 1：挂机等 AI 跑完，不用手动敲「继续」

AI 因网络抖动或「自以为完成」停下时，watchdog 自动催它继续；AI 真正完成时会收到默认文案的提示，主动调用 `stop_watchdog` 工具收尾，监控随之停止。

```
/watchdog                       # 空闲 60s 催一次，默认文案，最多催 50 次
/watchdog timeout=30            # 空闲 30s 催一次
/watchdog timeout=30 message=继续    # 自定义催促文案
/watchdog timeout=30 max=100    # 卡死保险上限提到 100 次
```

防呆细节：新会话里 AI 还没开始干活时不倒计时；你正在输入或正在按键操作（选命令、翻历史等）时倒计时暂停，停下后恢复。

监控停止只有一个入口：`/watchdog stop`，任何模式下都是彻底停止。

### 故事 2：长任务链，AI 多次「自以为完成」，监控别死掉

普通模式下 AI 调 `stop_watchdog` 监控就没了，可长任务链里它常常阶段性收尾、后面还有活。用 `mode=keep` 启动常驻模式：AI 调 `stop_watchdog` 只是**临时挂起**（状态栏 `⏱⏸`），你发下一条消息时监控自动满血恢复（计数清零，参数不变）。

```
/watchdog timeout=5 mode=keep   # 常驻模式，空闲 5s 催促
```

区别只在退出路径：

- AI 调 `stop_watchdog` → 挂起，等你下一个消息自动唤醒；
- 你执行 `/watchdog stop` → 彻底停止，不会被消息唤醒；
- 达到 `max` 上限 → 彻底停止（说明已彻底卡死，恢复没有意义）。

### 故事 3：sub-agent 无人值守

子 agent 没人敲命令。启动 pi 前设置环境变量 `PI_WATCHDOG`，语法与 `/watchdog` 参数完全一致，session 启动即自动开始监控：

```bash
PI_WATCHDOG=1                                   # 默认参数
PI_WATCHDOG="timeout=30 max=100"                # 空闲 30s，最多催 100 次
PI_WATCHDOG="timeout=5 mode=keep"               # 常驻模式

# 例：tmux 里起一个自带 watchdog 的 sub-agent
PI_WATCHDOG="timeout=30 max=100" tmux new-session -d -s work pi
```

环境变量随子进程继承，tmux/脚本里启动的 pi 都会生效。格式非法时会明确提示且不启动，不会静默装死。

## 命令一览

```
/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]
/watchdog stop      彻底停止（任何模式）
/watchdog status    查看状态
```

参数只有一个语法：`key=value`，命令与环境变量共用同一解析器，没有位置参数歧义、没有额外子命令。

## 给 AI 的接口

插件注册 `stop_watchdog` 工具供 AI 主动退出循环：

> 停止 watchdog 自动继续监控。当你已完成全部任务、不需要再被自动催促继续时调用此工具。若监控处于常驻模式，此调用只是临时挂起，用户发送新消息时会自动恢复监控。

## 安装

```bash
# 全局：所有项目生效
cp index.ts ~/.pi/agent/extensions/watchdog.ts

# 或项目级：仅当前项目生效
mkdir -p .pi/extensions && cp index.ts .pi/extensions/watchdog.ts
```

在 pi 中用 `/reload` 热加载。运行测试：`npm test`（vitest，24 用例；开发时用 `npm run test:watch`）。

# todo
- `⏱▶`图标不协调
- 确定停止工具是不是渐进式上下文注入
- index.ts去除使用说明注释
- 多久催促默认值改为5
- stop_watchdog之后能不能模拟一下用户按了esc，这样就能强行停止llm的回复了
- 之前的催促的消息不应该进入上下文
- parseConfig应该配合ctx.ui.notify精细化提示
- parseConfig添加单元测试（已由 tests/config.test.ts 覆盖）
