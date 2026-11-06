# 夸克 Skill CLI 行为实测笔记（QUARK-CLI-NOTES）

> 供「网盘备份维护」插件（`host/quark.js` 等调用方）使用。本文全部结论来自 **只调用命令行接口** 的实测，
> 未读取/分析 `quark-drive.cjs` 源码。可复现脚本：`test/quark-probe.mjs`。

- 实测时间：2026-11-04 13:48–13:55（Asia/Shanghai）
- CLI：`~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs`，版本 `1.0.25-876f30d`
- Node：`v24.13.1`，macOS（darwin），网盘账号 `shiein` / SVIP
- 会话参数：所有命令都带
  `--session-input "DSH 网盘备份维护插件探针" --session-id "dsh-probe-<ts>-<hex>"`（同一轮探针复用同一个 session-id）
- 目标目录：`dsh/` = `210e76226f274d749cfc712725c72c68`；`dsh/_archive` = `e3462aa31eb849dca82a96d8153dc41e`
- 网络命令统一 180s 超时；本轮网络时延波动较大（单命令 2–11s），耗时数字仅供参考

---

## 0. 结论速查

| 命令 | 成功形态 | 关键字段（插件该取哪个） | 失败形态 | 退出码 |
|---|---|---|---|---|
| `get-user-info` | 单行 `type:"result"` | `data.vipInfo.{vipType,used,capacity,expiresIn}`、`data.userInfo.nickname` | 单行 result，code≠0 | 0 / 1 |
| `browse`（带 `--task-dir`） | 单行 result，无 list/artifact | **`data.file_path`**（JSONL 路径，在 `<task-dir>/browse/` 下） | `code=-100`、`action:"node_error"`、`data:{}`、stderr 为空 | 1 |
| `download` | 1 条 progress×N + 1 条 result | **`data.filePath`**（落盘绝对路径）+ `data.fileName` | 单行 result：`code=21001 "文件找不到"`、`data:{}` | 1 |
| `upload` | progress + list + result | 进度 `data.{current,total,percent}`；FID 取 **`result.data.fids[0]`** 或 `list.data.fileId`；`result.data.fullPath` 只是父目录 | result code≠0（如 -204，文档值，本轮未触发）；单文件失败时 list 行 code≠0 | 1 |
| `move` | 单行 result（本探针只测失败） | 成功时文档称 `data.{fids,targetFid,move_path}` | 单行 result：`code=14001 "参数错误: [文件不存在]"`、`data:{}` | 1 |

一句话版本：**成败只看最后一条 `type:"result"` 的 `code`；路径取 `filePath`/`file_path`；FID 取 upload 的 `fids[0]`；progress 行没有 `code`。**

---

## 1. 公共 NDJSON 协议（实测确认）

每行一个 JSON：

```
{"code"?: number, "msg": string, "action": string, "type": "result"|"progress"|"list"|"artifact", "data": object}
```

- `type:"progress"`：长任务（download/upload）中间进度，**没有 `code` 字段**，不能因为缺 `code` 判失败。
- `type:"list"`：upload 的逐个子任务终态（成功/失败各一行）。
- `type:"artifact"`：browse/search 不传 `--task-dir` 时的完整结果文件行；**带 `--task-dir` 时不再输出**（本轮 browse 均为 0 条）。
- `type:"result"`：最后一行，成败以它的 `code` 为准（0 = 成功）。
- 所有命令 `stderr` 均为空（未加 `--verbose`）；错误也只写进 stdout 的 result 行。
- `msg` 是中文成功/错误文案；`action` 一般是命令名，但 CLI 自身异常（如 ENOENT）时是 **`node_error`**。

---

## 2. 探针实测记录

### 2.1 `get-user-info`

命令（实测）：

```bash
node ~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs get-user-info \
  --session-input "DSH 网盘备份维护插件探针" --session-id "dsh-probe-20261104-135410-…"
```

退出码 0，stdout 恰好 1 行（原样）：

```jsonl
{"code":0,"msg":"成功","data":{"vipInfo":{"vipType":"SVIP","expiresIn":1793980800000,"used":4712210253280,"capacity":6607807184896},"userInfo":{"nickname":"shiein"}},"action":"get-user-info","type":"result"}
```

| 字段 | 类型 | 含义 / 插件映射 |
|---|---|---|
| `data.vipInfo.vipType` | string | 会员枚举：`SVIP`（也可能是其他值；无会员时的缺省值未见样本） |
| `data.vipInfo.expiresIn` | number | **epoch 毫秒**。`1793980800000` → `2026-11-06T16:00:00.000Z`（北京时间 2026-11-07 00:00），距实测约 2.4 天。不是秒、不是字符串、不是剩余天数 |
| `data.vipInfo.used` | number | 已用字节（两次运行间从 4712210251682 变为 4712210253280，是实时值） |
| `data.vipInfo.capacity` | number | 总容量字节（6607807184896 ≈ 6.0 TB） |
| `data.userInfo.nickname` | string | 昵称 |
| 顶层 `notice` | — | **无**（成功结果不带 `notice`，本轮也没有升级/会员提示） |

结论：`Connection` 映射为 `vipType ← data.vipInfo.vipType`、`used ← …used`、`capacity ← …capacity`、
`expiresAt ← …expiresIn`（原样 epoch ms，不要 ×1000/÷1000）、`nickname ← data.userInfo.nickname`。

### 2.2 `browse` 失败模式（已知坑，重点）

命令（`--task-dir` 指向**不存在且未创建**的目录）：

```bash
node …/quark-drive.cjs browse --parent-fid 210e76226f274d749cfc712725c72c68 --all \
  --task-dir /tmp/definitely-not-exist-20261104-135410-b6c2
```

结果：**退出码 1，stdout 1 行，stderr 空，目录未被创建**：

```jsonl
{"code":-100,"msg":"ENOENT: no such file or directory, stat '/tmp/definitely-not-exist-20261104-135410-b6c2'","action":"node_error","type":"result","data":{}}
```

判定：

- **不是 code 0**。本轮实测失败一律 exit=1 且 `result.code≠0`，没有出现「退出码/`code` 仍为 0」的假成功。
- 但失败行 `action` 是 **`node_error`**（不是 `browse`）、`data` 为空、`stderr` 为空。按 `action==='browse'` 匹配结果行的插件会漏判；必须按 `code!==0`（或「拿不到 `data.file_path`」）判失败。
- `--task-dir` 必须由插件提前 `mkdir -p`；CLI 不会代建。成功时 JSONL 落在 **`<task-dir>/browse/browse-YYYYMMDD-HHMMSS-<6hex>.jsonl`**（多一层 `browse/`）。

插件侧建议：`browseAll()` 先 `mkdirSync(taskDir,{recursive:true})`（`host/quark.js` 已这样做，正确），
调用后以「有 result 行 && `code===0` && `data.file_path` 是存在的文件」为成功三条件；失败把 `code/msg` 原样带出。

### 2.3 `browse` 成功形态（`--task-dir` 已存在）

```jsonl
{"code":0,"msg":"成功","data":{"file_path":"/tmp/dsh-quark-probe-20261104-135410-a3ea/browse-tasks/browse/browse-20261104-135432-28552c.jsonl","parent_fid":"210e76226f274d749cfc712725c72c68","count":6,"hasMore":false},"action":"browse","type":"result"}
```

- `data.file_path`：JSONL 绝对路径，**只读这个字段，不要自己拼文件名**。
- `data.count`：本次条数（`dsh/` 为 6：`_archive` + 5 个快照）；`data.hasMore`：`--all` 下为 false。
- `--task-dir` 模式下 stdout **只有这一条 result**，没有 list/artifact（实测 artifact 0 条）。

JSONL 每行就是一个文件对象，无 `code/type` 包装。实测字段并集（12 个）：

```jsonl
{"fid":"~1…|4XJOXJLVl9w","parent_fid":"~1…|Xym7bQ4WRa4","category":0,"filename":"_archive","size":0,"file_type":"0","full_path":[{"missing":"dsh"}],"format_type":"","source_display":"agent_upload","created_at":1793767301254,"updated_at":1793771519955,"includeItems":9}
{"fid":"~1…|u1PbDRIKC8w","parent_fid":"~1…|Xym7bQ4WRa4","category":7,"filename":"dsh-snap-2026-11-04_132058.tar.gz","size":12153373,"file_type":"1","full_path":[{"missing":"dsh"}],"format_type":"application/gzip","source_display":"agent_upload","created_at":1793769664342,"updated_at":1793769664342}
```

| 字段 | 说明 |
|---|---|
| `fid` | `"~1<每次 browse 会变的前缀>|<稳定后缀>"`，含竖线；下载/移动要原样传 |
| `parent_fid` | 父目录 FID，格式同上 |
| `filename` / `size` | 文件名 / 字节数（目录 size=0） |
| `file_type` | **字符串**：`"0"`=目录，`"1"`=文件 |
| `category` | 数字：目录=0，`.tar.gz`=7，`.txt`/`.json`=4 |
| `format_type` | 目录 `""`，`application/gzip`，`text/plain`，`application/json` |
| `created_at` / `updated_at` | epoch 毫秒。目录 `_archive` 的 `updated_at` 会随子项增删变化 |
| `full_path` | **数组**，可能形如 `[{"missing":"dsh"}]`（路径解析失败），不是字符串，不要拼接展示 |
| `source_display` | 来源标记，agent 上传的为 `"agent_upload"` |
| `includeItems` | 只有目录条目有（子项数量），文件条目没有该字段 |

`dsh/` 当前形态（实测目录时点）：`_archive`（目录）+ 5 个 `dsh-snap-*.tar.gz`（各 ≈12.1MB，`file_type="1"`，
`category=7`，`format_type="application/gzip"`）。**dsh/ 下当时没有任何 `*.manifest.json` sidecar。**

### 2.4 `download`

先 `browse dsh/` 拿到快照 FID（取 `updated_at` 最新的 `dsh-snap-*.tar.gz`），再下载：

```bash
node …/quark-drive.cjs download --fid '~1…|u1PbDRIKC8w' \
  --output-dir /tmp/dsh-quark-probe-20261104-135410-a3ea/download --overwrite
```

- 退出码 0；12.1MB 文件耗时约 7–10s；stdout 共 **102 行 = 101 条 progress + 1 条 result**。
- progress 行样例（**无 code**，字段固定 `current/total/percent`）：

```jsonl
{"msg":"进行中","data":{"current":15388,"total":12153373,"percent":0},"action":"download","type":"progress"}
{"msg":"进行中","data":{"current":12103231,"total":12153373,"percent":100},"action":"download","type":"progress"}
```

- result 行（原样）：

```jsonl
{"code":0,"msg":"成功","data":{"fileName":"dsh-snap-2026-11-04_132058.tar.gz","filePath":"/tmp/dsh-quark-probe-20261104-135410-a3ea/download/dsh-snap-2026-11-04_132058.tar.gz"},"action":"download","type":"result"}
```

| 问题 | 实测答案 |
|---|---|
| `data` 里哪个字段是落盘路径 | **`data.filePath`**（驼峰）。`data.path`/`data.file_path`/`local_path`/`output_dir` 等**都不存在** |
| 文件是否真实存在 | 是。`stat(filePath).size == 12153373`，与 browse 的 `size` 完全一致 |
| `data.fileName` | 仅文件名（不含目录），可用于拼 `outDir/fileName` 交叉校验 |
| `--output-dir` 不存在时 | **CLI 自己创建目录**（实测 outDir 事先不存在，下载后存在） |
| 失败分支（假 FID） | exit=1，单行 `{"code":21001,"msg":"文件找不到","action":"download","type":"result","data":{}}` |
| progress 的 `percent` | 只是提示：`percent=100` 时 `current` 仍可能小于 `total`（本轮 12103231 < 12153373），**不要用 `current===total` 做完成门禁**，完成以 result 行为准 |

### 2.5 `upload`（1.4KB 文本 → `dsh/_archive`）

```bash
node …/quark-drive.cjs upload /tmp/dsh-quark-probe-…/probe.txt --parent-fid e3462aa31eb849dca82a96d8153dc41e
```

stdout 共 3 行（原样）：

```jsonl
{"msg":"进行中","data":{"current":1396,"total":1396,"percent":100},"action":"upload","type":"progress"}
{"code":0,"msg":"上传成功","data":{"recordId":"41256143-f8fb-476a-83b4-b6237ab65ee5","fileId":"562999fd0a3d49f387ab04eda46b3895","fileName":"probe.txt","fileSize":1396,"instantUpload":false},"action":"upload","type":"list"}
{"code":0,"msg":"成功","data":{"fileNames":["probe.txt"],"fileCount":1,"totalSize":1396,"fids":["562999fd0a3d49f387ab04eda46b3895"],"successCount":1,"instantUpload":false,"instantUploadCount":0,"fullPath":"夸克网盘/dsh/_archive","heapUsed":12648144,"rss":80216064},"action":"upload","type":"result"}
```

| 行 | 字段 | 说明 |
|---|---|---|
| progress | `data.{current,total,percent}` | 与 download 相同；小文件只有 1 条 100% |
| list | `data.{recordId,fileId,fileName,fileSize,instantUpload}` | 逐个子任务终态；失败时 `code`≠0 且 data 只有 `recordId` |
| result | `data.fileNames/fileCount/totalSize/fids/successCount/instantUpload/instantUploadCount/fullPath` | **`data.fids` 是数组，没有 `data.fid` 字段**；另有 `heapUsed/rss` 调试字段 |

关键实测细节：

1. **FID 取法**：`result.data.fids[0]` = `562999fd…3895`，与 `list.data.fileId` 相同。`result.data` 里没有 `fid`。
2. **上传返回的 FID 是 32 位 hex**，而 `browse` 返回的是 `"~1…|…"`。同一文件两串**不相等**，但都用 `download` 验证可用：
   用 `download --fid 562999fd0a3d49f387ab04eda46b3895` 成功取回文件，`data.fileName` 为真实文件名。
3. **`data.fullPath` 是“文件所在目录”**（`夸克网盘/dsh/_archive`），不是文件全路径，也不是本地路径，**不要当落盘路径**。
4. **同名冲突会被服务端自动改名**：`_archive` 已存在 `probe.txt`，本次上传的 1396B 文件实际落为
   **`probe(2).txt`**（前一轮探针留下了 `probe.txt`、`probe(1).txt`）。而 `list.data.fileName` /
   `result.data.fileNames` 仍报请求名 `probe.txt`。→ 插件如果要可靠拿到“真实远程文件名”，应在上传后
   `browse` 父目录，用「上传前快照里没有 + size 相同 + created_at 在上传开始之后」定位条目；
   或直接 `download --fid <fids[0]>` 让 `data.fileName` 回报真实名（多一次网络请求）。
5. progress 行无 `code`；list 行成功/失败都带 `code`；最终成败仍看 result 行。

### 2.6 `move`（只测错误路径，不做无意义真移动）

```bash
node …/quark-drive.cjs move 00000000000000000000000000000000 --target-fid e3462aa31eb849dca82a96d8153dc41e
```

退出码 1，stdout 单行（原样）：

```jsonl
{"code":14001,"msg":"参数错误: [文件不存在]","action":"move","type":"result","data":{}}
```

- 失败也是单行 result、`data:{}`、stderr 空；`code=14001` 属于参数/文件不存在，**不是网络错误**，不要重试。
- 成功形态按 CLI 文档为 `data.{fids,targetFid,move_path}`（本轮未触发真移动，未实测）。

### 2.7 FID 稳定性（额外发现，重要）

对同一批文件连续两次 `browse`（间隔约 20s，6 个条目逐一对比）：

- `identicalFidCount: 0`，`identicalSuffixCount: 6`。
- 即：`"~1…"` 前缀每次 browse 都不同，`"|"` 之后的短后缀稳定（后缀能标识对象/父目录，如 `_archive` 的 `|4XJOXJLVl9w`
  与其内部文件的 `parent_fid` 后缀一致）。
- 补充：13:48 取得的 FID 在 13:52 仍能成功 download（跨 4 分钟）；**未测小时级/重启后是否过期**。

插件建议：不要把 FID 当永久键缓存（例如 `backup-meta.json` 里存一年的 fid 风险未知）。
下载/移动前重新 `browse` 父目录、按 `filename`（+ `size`）匹配最新 FID；`Snapshot.fid` 每次列表刷新时更新。

### 2.8 超时 / 网络异常

本轮未改网络、未复现断网（探针 7 标记 skipped）。按脚本设计所有网络命令 180s 超时。
通用判定建议：**超时/被 kill 时没有 `type:"result"` 行**，`stderr` 可能为空，此时不能只看退出码或 `code`，
应把「无 result 行 && 进程超时/被信号杀死」统一判为 network/timeout 错误（`host/quark.js` 的 `timedOut` 分支方向正确）。

---

## 3. 插件侧调用建议（可直接照做）

### 3.1 路径字段

| 用途 | 字段 | 备注 |
|---|---|---|
| browse 结果 JSONL | `result.data.file_path` | `<task-dir>/browse/…jsonl`，只读不拼 |
| download 落盘文件 | `result.data.filePath` | 绝对路径；`data.fileName` 为 basename |
| upload 目标目录 | `result.data.fullPath` | **父目录**文案，不是文件路径 |
| 快照名 | browse JSONL 的 `filename` | 用 `dsh-snap-YYYY-MM-DD_HHMMSS.tar.gz` 正则筛选 |
| 快照大小 | browse JSONL 的 `size` | 与下载后 `stat` 对比做完整性校验 |

### 3.2 失败判定

推荐顺序（统一封装成 `call()` 的返回值）：

1. 取 stdout 最后一条 `type==="result"`：没有 → 失败（超时/崩溃/无输出）。
2. `result.code !== 0` → 失败；`code===0` → 成功。
3. 命令专属成功条件再校验：browse 要求 `data.file_path` 存在且可读；download 要求 `data.filePath` 存在；
   upload 要求 `fids[0]` 存在；`get-user-info` 要求 `data.vipInfo/userInfo` 存在。
4. 退出码只作辅助：本轮实测成功=0、失败=1（与 `code` 一致），但**超时/被 kill 时没有 result 行**，
   所以“退出码 0 即成功”或“退出码非 0 即失败”都不足以覆盖全部情况。

错误分类建议：`-100`（ENOENT，本地目录/文件问题）、`-104`（会话环境，CLI 需要 `DSH_HOME`/`DSH_SESSION_ID` 继承）、
`14001`（move 参数/文件不存在）、`21001`（download 文件找不到）、`31003/32003/32004`（上传 hash/空间/大小限制）
都不是网络错误；只有「无 result 行 + 超时/网络异常 msg（network/fetch/timeout/ENOTFOUND/ECONNRESET…）」才归 network。

### 3.3 progress 阶段映射

- `download`：progress `data.percent` 0→100 映射到 restore 任务 `stage:"download"` 的 `progress`；
  收到 result 行后进入 `extract`。**完成唯一条件是 result 行 code=0**（`percent=100` 时 `current` 可能未到 `total`）。
- `upload`：progress 映射到 backup `stage:"upload"`；但注意一次备份可能包含「快照 tar + sidecar json」两次 upload，
  每次 upload 的 progress 都是 0→100，插件应把两次合并（例如按已上传字节/文件权重）或分阶段展示，
  不要直接拿第二次的 percent 覆盖整体。
- progress 行没有 `code`，解析时不要 `if (!line.code) fail`；只对 `type==="result"` 检查 code。

### 3.4 sidecar（`*.manifest.json`）上传与 FID

实测 sidecar 样本（202B JSON 上传到 `_archive` 后 browse 得到的 JSONL 行）：

```jsonl
{"filename":"dsh-probe-20261104-135410-2642.manifest.json","size":202,"file_type":"1","category":4,"format_type":"application/json","created_at":1793771735192,"updated_at":1793771735192,"fid":"~1…|J2TYH6zQ_uY","parent_fid":"~1…|4XJOXJLVl9w"}
```

| 问题 | 答案 |
|---|---|
| sidecar 上传后如何拿 FID | 用 upload 的 `result.data.fids[0]`（32 位 hex，已验证可 download）；需要与网盘列表对应时再 browse 按 filename 匹配 |
| sidecar 在 JSONL 里长什么样 | `file_type:"1"`、`category:4`、`format_type:"application/json"`、`format_type` 非空可用于识别；`size` 为 JSON 字节数 |
| 命名建议 | `<snapshot>.manifest.json` 与快照同名不同后缀，便于按 filename 关联；快照名唯一时不会触发服务端改名 |
| 若上传重试同名 | 会被改名为 `xxx(1).manifest.json`，响应不体现；发现 sidecar 缺失/对不上时，browse 父目录按 size/created_at 兜底 |
| dsh/ 现状 | 本轮实测时 dsh/ 下**没有**任何 sidecar；插件应容忍“只有 tar、没有 manifest”的历史快照（快照预览回退读 tar） |

`Snapshot` 映射：`name ← filename`、`size ← size`、`fid ← fid`、`createdAt ← created_at`（epoch ms）、
`sidecarFid ← 对应 manifest 条目的 fid`、`sidecarSize ← manifest 的 size`；两者都用**最新 browse 结果**的 FID。

### 3.5 对 `host/quark.js` 的偏差提醒（只读代码，未修改）

1. **`upload()` 取 FID 会拿到 null**：当前写的是 `data.fid || data.file_fid || data.fileId`，但实测 result.data
   只有 `fids[]`（list 行才有 `fileId`）。应改成
   `data.fids?.[0] ?? <list 行 data.fileId>`；否则备份流程记录不到 sidecar/快照 FID。
2. **`download()` 的路径候选列表**已包含 `filePath`，实测可用，无需改；可删掉不存在的候选（无副作用）。
3. **`upload()` 的 `data.fullPath`** 是父目录，若 UI 要显示“上传到 xxx”可原样用；不要拼成文件路径。
4. **`browseAll()`** 先 `mkdir` 再传 `--task-dir`、只读 `data.file_path`，与实测一致，正确。
5. **FID 不稳定性**：`browseAll()` 每次返回新 FID 前缀，若上层把 `Snapshot.fid` 长期持久化（跨天还原），
   建议下载前重新 browse 按 filename 刷新，而不是直接用缓存 fid。

---

## 4. 已知限制

- CLI **没有删除命令**（只有 move / create-folder）。探针上传的文件会永久留在 `dsh/_archive`，只能用户手动处理。
- 同名文件上传会被服务端自动改名 `name(1).ext`，且响应不体现真实名。
- FID 前缀每次 browse 都变，长期有效性未知（4 分钟内仍有效）。
- `download` 不能指定文件名；落盘名由服务端 `fileName` 决定，`--overwrite` 只影响同名覆盖。
- `upload` 的 `--parent-fid` 不传时行为由服务端决定（不要自动补 `"0"`）。
- `move` 成功路径本轮未实测（避免产生无意义网盘变更）。
- 断网/超时表现未实测（不改网络）；按「无 result 行」判定即可。

---

## 5. 测试残留（用户手动清理用）

### 5.1 网盘 `dsh/_archive`（CLI 无删除能力，需手动 move/删除）

| 文件名 | 大小 | 来源 | upload 返回的 FID |
|---|---|---|---|
| `probe.txt` | 1103 B | 手工首轮探针 | `631e53e6d60e41129ff6700b6027a224` |
| `probe(1).txt` | 1396 B | `quark-probe.mjs` 第 1 轮（同名自动改名） | `96d785fa94c84eb5b6dc9d909c99829a` |
| `probe(2).txt` | 1396 B | `quark-probe.mjs` 第 2 轮（同名自动改名） | `562999fd0a3d49f387ab04eda46b3895` |
| `dsh-probe-20261104-135137-c37f.manifest.json` | 202 B | 第 1 轮 sidecar 样本 | `137c5f0ce0fd438d9ebcdf470daaf20e` |
| `dsh-probe-20261104-135410-2642.manifest.json` | 202 B | 第 2 轮 sidecar 样本 | `1961f0dab53d440cb339e85a7f782bb8` |

（`_archive` 条目数由 6 → 11；6 = 原有快照文件，以上 5 个均为探针残留。）

### 5.2 本地 `/tmp`

- 本轮下载的 12.1MB tar 在探针内**校验后立即删除**（`localFileDeletedAfterProbe: true`）。
- 临时目录 `/tmp/dsh-quark-probe-<ts>-<hex>/` 保留日志与 `summary.json`（默认保留；`--clean` 会删）。
  实测结束后已统一清理本轮 `/tmp/dsh-quark-probe-*` 与 `/tmp/archive-now`。

---

## 6. 复跑方法

```bash
cd ~/Documents/workspace/dsh-maintenance-backup
node test/quark-probe.mjs                 # 全量实测，stdout 输出 JSON 汇总；
                                          # stderr 打每条命令的 exit/code/耗时；明细日志在 <tmpRoot>/logs/
node test/quark-probe.mjs --skip-network  # 不发网络请求，只打印本文已实测结论
node test/quark-probe.mjs --full          # JSON 汇总里保留完整原始 stdout
node test/quark-probe.mjs --clean         # 结束后删除本地临时目录（网盘残留不会删）
node test/quark-probe.mjs --timeout 240000
```

可用环境变量覆盖：`QUARK_CLI`、`QUARK_DSH_FID`、`QUARK_ARCHIVE_FID`、`QUARK_PROBE_TMPDIR`、`QUARK_PROBE_TIMEOUT_MS`。

每次全量运行会新增 1 个 `probe*.txt` + 1 个 `*.manifest.json` 到 `dsh/_archive`（自动化需要幂等时，
可把上传目标改成一次性目录或改为 `--skip-network` 只读回放）。
