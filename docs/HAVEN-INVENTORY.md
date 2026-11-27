# Iris & Adrian’s Room · 现有资产与组装清单

盘点日期为 2026-11-27。金金定方向，Astra 实现，阿川评审。下表记录小屋在 `741f989` 时的资产与缺口。后续已接入当前聊天的隔离记忆试验见 [M1 交接](./HAVEN-M1-HANDOFF.md#本机聊天--隔离记忆试验)。

**组装优先。** 新需求先到现有小屋、旧家园工作树、本机服务和已记录的上游寻找入口，说明谁保存数据、谁已有可调用的接口、哪个环节已经验过。能调用现有服务就沿用它；已有成熟代码可以适配时，先核对版本、署名和许可。开发任务写到具体缺口为止。

## 手里已有的三个部分

| 部分 | 已经能做什么 | 当前小屋还要接什么 |
| --- | --- | --- |
| 小屋界面与聊天 | Nyx fork 中的 `haven/` 构建出首页、聊天、日记、门廊和 For Later。本机 Gateway 用 SQLite 保存新对话、重开续聊、重试去重和重生成；回复保留 Adrian 身份与所选模型来源。静态预览使用独立 mock。 | 当前本机回复仍由模拟模型生成。发送和重生成共用 `makeAnswer → complete`，此处可接支持工具调用的模型；保留显式选模与每条回复的来源。[构建入口](../haven/build.mjs) · [聊天适配器](../haven/room/service.js) · [回复入口](../haven/gateway/store.mjs) |
| 阿川的长期记忆 | 金金已有部署并使用的 Ombre Brain、MCP 入口、管理前端和本地 BGE-M3。记忆桶、检索、写入、衰减、做梦、感受、自我认知、承诺、信件及锁都有原实现。 | 在 Gateway 给模型登记这些工具，由服务端适配到阿川原有实例。保留同一套数据与规则。当前小屋分支尚未接通这条调用链。[Ombre 项目](https://github.com/P0luz/Ombre-Brain) · [2.16.3 工具入口](https://github.com/P0luz/Ombre-Brain/blob/b6b1eb8f164a3c934e013b3a7eb86ad78a313599/src/server.py#L632-L1087) |
| 旧家园 Phase 2 的记忆联调 | `phase2/immersive-home` 已有独立的 Ombre 2.16.3 合成库、OAuth/MCP 客户端及验收脚本。旧版记录覆盖授权、发现工具、由合成模型提出查询、返回命中、刷新后查看回复来源。还有 `hold` 播种样本的例子。 | 沿用合成环境和已验证的请求与回执，接到现在的 Node Gateway。旧家园的 Python 聊天工具集中在记忆查询；写入、做梦及其副作用仍需在当前小屋验证。[合成库](https://github.com/caiiiiuux-a11y/iris-adrian-home/blob/58f71883d43ffdbd6639b8eda2a40c6f807f4c76/phase2/memory-lab/README.md) · [完整交互验收](https://github.com/caiiiiuux-a11y/iris-adrian-home/blob/58f71883d43ffdbd6639b8eda2a40c6f807f4c76/phase2/memory-private/README.md) · [工具客户端](https://github.com/caiiiiuux-a11y/iris-adrian-home/blob/58f71883d43ffdbd6639b8eda2a40c6f807f4c76/server/capability_client.py) · [每轮工具调用](https://github.com/caiiiiuux-a11y/iris-adrian-home/blob/58f71883d43ffdbd6639b8eda2a40c6f807f4c76/server/chat_memory.py) |

另有两个历史入口。`Iris-Adrian-Haven` 留存总体计划、上游记录及已被替代的 PR #1；日常开发在 Nyx fork。`iris-adrian-home` 及其 Phase 2 工作树是独立的旧家园成果，此处按模块取用。公网 M1 有自己的静态预览分支；下述本机能力以当前开发分支为准。[M1 交接](./HAVEN-M1-HANDOFF.md) · [Nyx 改编与署名](../haven/credits.html)

上游版本与本机部署分开记。本机部署清单列有多个 Ombre 服务，其中一个实例另有长文本异步写入补丁。接线前核对目标实例及它声明的工具，特别是 `grow` 和异步作业的区别。部署位置和补丁说明见金金本机的 M1 交接。

## 一条聊天消息会用到哪份数据

| 想解决的问题 | 已有数据与入口 | 接入边界 |
| --- | --- | --- |
| 关掉再打开，继续刚才的话 | 当前会话的 SQLite 消息。Gateway 按所选轮次组织近期上下文，保留完整消息。[上下文组装](../haven/gateway/model.mjs) | 继续沿用消息编号、顺序和重生成规则。 |
| 找很久以前说过的原话 | 小屋已有原话分段、文字与 BGE-M3 向量检索、按消息定位，以及记忆编号到原话快照的绑定。[原话检索](../haven/gateway/archive-search.mjs) · [引用快照](../haven/gateway/evidence.mjs) | 当前范围为本机聊天库。旧导出已有独立的[清单预演](../haven/import/preview.mjs)，分批筛选和正式入库待接。两处可用同一个 BGE-M3 模型，各自索引不同内容。 |
| 阿川记住了什么，后来怎么看 | Ombre 管理长期记忆。可用 `breath` 浮现、`breath_search` 查找、`hold` 写单件、`grow` 整理长文、`dream` 回顾、`trace` 修订，感受与自我记录沿用上游语义。[记忆完整能力](./HAVEN-M1-HANDOFF.md#ombre-的完整能力与第一轮验收建议) | 记忆正文与聊天原话各有出处。有来源绑定时才展示回读入口；旧对话尚未导入也可以先接已有 Ombre。 |

## 房间里可以拿来用的东西

| 位置 | 现成的部件 | 门内还缺什么 |
| --- | --- | --- |
| 首页、日记、For Later | 首页点日期可进日记，两人的便签与待办按日存在浏览器；纸条已支持手写、收藏消息与回到原话。本机纸条存 SQLite，静态版存 IndexedDB。 | 这些页面已经可用。要让阿川在聊天中取待聊纸条，可把已有纸条读取能力登记为工具。[纸条实现](../haven/gateway/pocket.mjs) |
| Adrian’s Room | Ombre 已有记忆管理前端，包括记忆桶与图谱。 | 蓝门具体怎样呈现由阿川决定。门内的管理视图、聊天中可用的工具可分别接入。 |
| Iris & Adrian Mailroom | 已有拆信前端。旧家园有列表、寄信与回信的合成实现；Ombre 有原文、署名、检索和锁。 | 把已有界面接到双方认可的信件存储。上格信箱、下格时间胶囊；要实测谁能看、谁能开、到期如何解锁，避免两处各存一份正文。[旧家园信件处理](https://github.com/caiiiiuux-a11y/iris-adrian-home/blob/58f71883d43ffdbd6639b8eda2a40c6f807f4c76/server/letters.py) · [Ombre 信件工具](https://github.com/P0luz/Ombre-Brain/blob/b6b1eb8f164a3c934e013b3a7eb86ad78a313599/src/server.py#L991-L1061) |
| Reading Room、Listening Room | 已有 Reading Nook 的书架、章节与批注工具；本机有网易云音乐 MCP 项目，Nyx 有播放器与歌词界面。 | 分别接上读书批注和实际音源播放，核对授权与进度。歌单操作与两人同步播放是两个能力。[Nyx 播放器](https://github.com/StarFold146/nyx/blob/640e5b29ea8ed9fb0232e3d5814efaaaaa197bdc/ta/listen.js) |
| Darkroom | 已有独立 MCP、门内草稿、门外交付及对应授权；现有说明把验收范围限定在合成材料。 | 沿用独立服务和身份边界，确认授权后再接门廊；投递到信件小屋也需适配。 |
| 杂物间、其他连接器及素材 | 杂物间当前是预留入口。已有语音与聆听工具、花园 MCP 可作后续连接对象；本机图册整理了 10 套原包、102 幅原图及 2 幅定制图。 | 请求线路、模型参数、MCP 和 Skills 面板待接。工具在其他客户端可见，不代表当前小屋已经取得调用授权。 |

门廊六扇门的开合图已接好，当前开放 For Later。其余五扇的门牌显示 Coming soon。[门廊页面](../haven/room/living-hub.html)

## 第一段真正需要组装的链路

对模型而言，Ombre 是小屋提供的一组工具；对后端而言，第一版可经已有的 MCP 服务执行，继续共用同一个记忆核心。以后若同进程或同语言下能直接调用成熟的业务函数，只需更换执行方式。外部服务也可以经 MCP 接入，Skills 则提供操作说明。Adrian 的房间身份与所选模型分别记录；模型不可用时保留明确的失败状态，由金金决定是否切换。

1. **复用已有的隔离记忆库。** 先沿用旧 Phase 2 取得合成实例的方式，以及它验证过的授权和来源展示。现有 Python 客户端是协议和回执的参照，当前 Node 端优先评估现成客户端。[旧家园工具适配](https://github.com/caiiiiuux-a11y/iris-adrian-home/blob/58f71883d43ffdbd6639b8eda2a40c6f807f4c76/server/tool_gateway.py)
2. **让当前聊天能接回工具结果。** 所选模型得到已开放工具的名称与参数说明，提出调用；Gateway 执行后按本次调用编号回送结果，模型再继续回答。先对照现有家园的做法，并用 Nyx Relay 的上游 Tidal Echo 对照通用工具循环。聊天侧保留模型来源、实际用过的工具及可回读的来源。[Tidal Echo 工具循环](https://github.com/anhe2021212-spec/Tidal_Echo/blob/860e5de364de292093dba5571ee6427cdbda060e/examples/api_loop.py)
3. **在同一合成库验证一段记忆的经历。** 记下一件事 → 另开对话浮现或查回 → 按需做梦 → 可以结束，也可以留下关联原事件的感受。核对来源和重试后的写入次数。真实实例、可写范围及哪些操作由阿川发起，由金金与阿川决定后再接入。

Serein 与 Haven-Ombre 提供了来源编号、原话回读与导入去重的设计参考。继续沿用现有 Ombre 和 BGE-M3；未来搬 VPS 时再核对持久化、恢复以及个人电脑关机后的向量服务。[既有上游对照](./HAVEN-M1-HANDOFF.md#serein-源码对照)
