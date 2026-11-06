# 维护者说明

这个插件怎么改、改哪里、改完怎么验。用户文档在 `README.md`（中文，GitHub 默认）与 `README.en.md`（英文），这里只记维护者需要的东西。

## 目录布局

```
index.js            Host 半边：/api/dsh-workbench 下的 HTTP 路由（仅 loopback）
client.js          浏览器半边：slot 注册 + 整个面板 UI（含双模式）
cordis.patch.yml   bundle 层配置（路径全可留空，留空 = 首次引导里问用户）
lib/
  vault.js         进 vault 的唯一通道：发现 / 读 / 写 / 冲突 / 深链 / 目录树
  cards.js         cards.json 校验，坏了回退内置八卡
  prompts.js       prompts.json 模板
  table.js         通用「一张 Markdown 表」：解析 / 校验 / 备份 / 原子写（术语表与三张表共用）
  glossary.js      术语表：中｜英｜领域｜标签｜备注
  tables.js        造价三表：计价依据 / 材料价格 / 变更签证台账
  recordings.js    WAV 拼装、分片追加、波形、转写稿、批注
  volc-asr.js      火山引擎流式 ASR 桥（sessions / chunks / finals），热词表
  iflyrec.js       讯飞本地 MCP 客户端（整文件转写）
  volc-ws.js       最小 WebSocket 客户端（需要自定义握手头）
  usage.js         用量角标（DeepSeek 余额 + 语音剩余时长）
test/              node test/all.mjs
locale/            zh / en 显示名
scripts/           install.ps1（装机）、seed-vault.ps1（建库与种子数据）
```

数据：项目数据（资料库笔记、会议记录、三张表）跟在 DSH 会话的工作区里；公共资料库（术语表、
提示词模板）在配置的 vault 里；`cards.json`、`prompts.json`、`config.json`、可选的 `asr.json` 在
`~/.dsh-workbench/`。

设置页（`settings.section`）同一页管理两件事：vault 路径/子目录（`/config`）与语音凭据
（`/credentials`，读 `asr.json`，响应只给「已配置」布尔值，绝不回显明文；显式清除走 `clear` 数组）。

## 项目上下文（会话工作区 = 项目根）

客户端打开面板时 `POST /context { sessionId }`；Host 读 `~/.dsh/storages/workspace.json`
（可用 `workspaceIndexFile` 覆盖，测试用），把该会话绑定的工作区路径当作项目根，
然后 `rebuild()`：

- `vaultRoot = 项目根`，`sopDir = ''`（资料库就是项目文件夹本身）
- 三张表 → `<项目根>/造价工作台/`
- 会议记录 → `<项目根>/会议记录/`
- 术语表仍是公共库的 `Workbench/术语表.md`（`vaultRoot` 配置只影响公共资料）
- 没有会话工作区（空 sessionId / 索引里找不到）→ 回退公共库旧布局

项目切换不落盘（不写 config.json）：每次面板打开/会话变化重新解析，因此多个会话各自
跟随自己的工作区。改这里的路径派生逻辑时，`buildStores()` 是唯一入口。

相关路由：

```
POST   /context            解析会话工作区并重建（sessionId 为空 = 回退公共库）
```

## 造价三张表：CRUD 机制

三张表共用 `lib/table.js`，`lib/tables.js` 只声明列、主键和落盘文件名（`createCostTables({ workbenchDir })`）：

| kind | 文件（vault 相对路径） | heading | 表头（= 列顺序） | 主键字段 |
|---|---|---|---|---|
| `standards` | `Workbench/计价依据.md` | `# 计价依据速查` | 编号 / 名称 / 类别 / 版本文号 / 实施日期 / 备注 | `code` |
| `prices` | `Workbench/材料价格.md` | `# 材料价格库` | 材料 / 规格 / 单位 / 单价 / 地区 / 日期 / 来源 | `name` + `spec` + `unit` + `region` |
| `changes` | `Workbench/变更签证台账.md` | `# 变更签证台账` | 编号 / 项目 / 事由 / 金额 / 日期 / 状态 | `code` |

术语表（`glossary`）是同一个机制的老实例：`Workbench/术语表.md`，`# 造价中英术语表`，
五列 `中文 / 英文 / 领域 / 标签 / 备注`，主键 `zh` + `en`，另有 `tidyTags` 把标签规整成半角逗号分隔。

**路由**（`index.js` 的 `handleEntryTable`，四张表共用一套）：

```
GET    /api/dsh-workbench/<table>[?q=]   列表（q 对全部字段做大小写不敏感过滤）
POST   /api/dsh-workbench/<table>        新增，body 即字段对象
PUT    /api/dsh-workbench/<table>/:id    修改（id 变了等同"删旧加新"）
DELETE /api/dsh-workbench/<table>/:id    删除
```

- `id = sha1(主键字段用 \0 连接).slice(0, 12)`，主键字段全空时拒绝新增；与现有条目主键重复会被拒（400 `duplicate`）。
- 字段校验：不能含竖线 `|`、换行、制表符，单字段 ≤ 200 字；报错带列名。
- 写盘纪律（`lib/table.js`）：先解析现有文件（解析不了就拒写，原文件不动）→ 现有字节复制到 `<file>.bak` →
  写同目录临时文件 → `rename` 覆盖。任何一步失败原文件保持旧内容。
- 备份：表文件旁边的 `.bak`；资料库笔记的备份在 `Workbench/.backups/`（`vault.js` 的 `writeBackup`）。
- 读不到文件时返回空表 + `exists:false`，不报错；新建空表是正常状态。
- 全局搜索 `/search` 与卡片摘要 `/overview` 都读同一份 `costTables` / `glossary`，`counts` 键是
  `sop / glossary / recording / standards / prices / changes`。

**加一列或加一张表时，四处必须一起改**：`lib/tables.js` 的 `header/keys/idKeys`（必要时 `heading/intro`）→
`index.js` 的 `entryTables` → `client.js` 的 kind 分派与 TableCard 渲染 → `scripts/seed-vault.ps1`
的种子表头。漏一处就会出现「界面能写、文件读不回来」这类最难查的问题。

## Slots

| Slot | Key | 用途 |
|---|---|---|
| `conversation.session.header.actions` | id `dsh-workbench` | 会话标题旁的图标按钮 |
| `conversation.hero.options` | id `dsh-workbench` | 空会话输入框上方的入口 |
| `sidebar.right.pane.tab` | key `dsh-workbench.panel` | 右侧栏里的面板主体 |
| `shell.overlay` | id `dsh-workbench-full` | 放不进右侧栏时的浮层（快捷键 `Alt+W` / `⌥W`） |
| `settings.section` | id `dsh-cost-workbench` | 「设置」新增一个造价工作台分区（库路径/子目录，组件收到 `{ close }`） |
| `settings.section.icon` | id `dsh-cost-workbench` | 上一条导航行的图标（id 必须一致） |

客户端标识（slot id、`TAB_ID`、`TAB_KIND`）仍是 `dsh-workbench` 前缀，与包名 `dsh-cost-workbench`、
patch id `dsh-cost-workbench` 刻意分开：改客户端标识会让用户已保存的面板状态失效。改之前先读 `client.js`
顶部常量与 `cordis.patch.yml`。

## 非协商项

1. **绝不调用 `layout.openRightbar()`。** 强行展开右侧栏会留下"显示了但空着"的一列，宿主随后藏掉自己的
   侧栏开关，整个右栏看起来就没了。先试 `sidebarRight.openResource()`，抛错再开浮层。
2. **面板组件里绝不引用录音器的 `sessionRef` / `statusRef`。** 卸载时会抛错并带崩整个侧栏（连文件预览一起挂）。
3. **面板渲染包在 try/catch 里**，一张坏卡不能把整片面板打白。客户端错误转发到 `<dataDir>/client-errors.log`。
4. **每条路由都要 loopback 围栏**：远端地址 + Host 头 + 同源。
5. **写笔记用 compare-and-swap**：`PUT /sop/note` 带 `expectedSha1`，不一致返回 409。
6. **备份进 `.backups/`**，不要散落在笔记旁边。
7. **深链走 Host**（`POST /open-obsidian`）；Web 外壳会丢掉 `obsidian://`。
8. **路径不得越出 vault**：`resolveInside` 拒绝绝对路径与 `..`。
9. **凭据永不出机器，也永不出现在响应里。**
10. **双模式只写 `localStorage`**：键名 `dsh-cost-workbench.mode`，取值 `cost` / `lite`，默认 `cost`。
    绝不写进 vault，也不塞进 config.json——它是「这台机器上的显示偏好」，不是数据。
11. **造价计算器先写纯函数**（`WB_CALC`：组价、总造价、钢筋理论重量、单位造价/含钢量、单位换算），
    再接 UI；所有金额算式保留中间过程，方便用户核对。
12. **三张表的列名是契约**：`lib/tables.js`、`client.js`、种子脚本、README 必须一致，改列名等于改数据格式。

## 录音与转写

- 音频在浏览器里拼成 WAV（16k / 16bit / 单声道），按分片追加；finalize 时补文件头，`list()` 会修复孤儿头。
- WebSocket 放在 Host：火山引擎用握手头鉴权，浏览器发不出去。
- 会话超时是**按空闲算**的。不要改回绝对时长——那会切掉所有超过 2 分钟的录音。
- 暂停 = 结束当前转写段；继续 = 带 `offsetMs` 开新段，服务端追加到同一份 `转写.md`。
- 静音 2 分钟 → 结束 ASR 会话（省额度）；重新有声音 → 开新会话。
- `No audio was received` 是段结束的正常信号，不是失败。
- 热词：`asr.json` 里可选的 `volcengine.boostingTableId`，按 `corpus.boosting_table_id` 发送；
  不配，控制台里配的热词表不生效。
- 录音与转写稿落在 vault 的 `会议记录/`（`recordingsDir` 可配）。

## 哪些改动何时生效

| 改动 | 生效方式 |
|---|---|
| `cards.json` / `prompts.json` / 术语表 / 三张表 / 笔记 | 刷新页面（每次请求都读盘） |
| 双模式切换 | 立即（localStorage） |
| 切换会话 / 工作区 | 立即（面板重新 POST /context 并重建） |
| 设置 → 造价工作台里保存配置 | 立即（Host 原地重建，不用重启） |
| `client.js` | 重启 DSH（打包版没有热重载快捷键） |
| `index.js` / `lib/*` | 重启 DSH |
| `cordis.patch.yml` | 重启 DSH |
| 面板里保存的首次配置 | 立即（store 原地重建） |
| `scripts/*.ps1` | 下次运行脚本；`install.ps1` 的结果需要重启 App |

## Windows 相关

- 打开 Obsidian 等外部动作走 `openCommand`，留空时按平台选：Windows `cmd /c start`、macOS `open`、Linux `xdg-open`。
- vault 绝对路径校验接受盘符路径（`E:\...`）与 UNC（`\\server\share`）。
- 快捷键在 Windows 上是 `Alt+W`；macOS 上是 `⌥W`。
- 脚本必须能在 PowerShell 5.1 下跑：只用内置 cmdlet、不联网、路径一律加引号；`.ps1` 文件保存为
  **UTF-8 with BOM**（5.1 读无 BOM 的 UTF-8 中文会乱码）。

## 测试

```bash
node test/all.mjs           # 依次跑 unit.mjs / routes.mjs / client-smoke.mjs
node test/routes.mjs        # 只跑路由套件（调试时用）
```

提交前至少跑一遍 `node test/all.mjs`，再用安装脚本与种子脚本各跑一次（脚本是纯 PowerShell，不进 node 测试）。

## 已知缺口

- 笔记里的图片不渲染，显示成文件名标签。
- Markdown 渲染刻意精简（标题、列表、加粗、代码、双链、frontmatter）。
- 批注锚定到多行选择的起始行；高亮颜色固定。
- 导入音频转写没有进度条。
- 三张表没有跨进程写锁：工作台与 Obsidian 同时改同一个表文件时，后写的一方可能覆盖前一方（有 `.bak` 兜底）。
- 造价计算器只做算式，不自动套定额、不自动联动材料价格表。
