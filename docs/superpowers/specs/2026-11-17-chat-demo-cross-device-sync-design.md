# chat-demo 跨设备同步设计

- 日期：2026-11-17
- 状态：待评审
- 范围：浏览器本地数据（IndexedDB + localStorage）与 GitHub 私有仓库之间的双向同步

## 1. 背景

chat-demo 是纯静态应用：会话与图片原件保存在 IndexedDB，设置与 API Key 保存在 localStorage，数据按浏览器配置和站点源（origin）隔离。因此同一账号在不同设备、不同浏览器、不同部署地址（`github.io` / `file://` / 自有域名）之间完全不相通。

现有历史导入导出是 ZIP 整包**替换**语义，只能做手动迁移，无法多端并行使用。本方案在保留“本地优先、无自建后端”的前提下，用用户自己的 GitHub 私有仓库作为同步介质。

## 2. 目标

1. 多设备之间同步会话与图片原件，后台尽量自动，聊天过程不被打断。
2. 同一会话在两端同时产生新消息时**不丢消息**，多出来的对话可通过现有分支切换查看。
3. 无自建后端、无账号体系；用户只提供一个 fine-grained PAT。
4. 同步失败不影响本地读写，恢复后自动补齐。

## 3. 非目标

- 自建同步服务、Supabase 等托管后端。
- 多人协作、实时协同编辑。
- 设置项（主题、语言、位置、开关）、API Key、未发送草稿的同步。
- 聊天内容端到端加密（列为后续扩展，见第 14 节）。
- 旧数据库迁移：与现有导入导出一样，只支持当前数据格式。

## 4. 现状约束

| 约束 | 位置 |
| --- | --- |
| `Session.updatedAt` 已存在，消息为带 `parentId` / `selectedChildId` 的分支树 | `src/services/chat/types.ts` |
| 消息 id 为 UUID v4，跨设备不会碰撞 | `src/utils/id.ts` |
| 写库入口集中在 `persist()`，流式回复也走它 | `src/services/chat/store.ts` |
| 导入/导出/全部删除已用串行队列避免交错 | `src/services/chat/backup.ts` |
| 删除会话会同时清理无引用的附件原件 | `src/services/chat/db.ts`、`store.ts` |
| 图片原件以本地附件 id 为主键存储，不天然按内容去重 | `src/services/chat/db.ts` |
| 已有 Toast 轻提示 | `src/components/base/toastState.ts` |

## 5. 方案总览

- 介质：单个 GitHub 私有仓库、单个分支，每次同步产生**一个 commit**，`force` 覆盖分支引用。
- 快照组织：Git 树快照（`manifest.json` + 每会话一个 JSON + 内容寻址附件），用 `base_tree` 复用未变更 blob。
- 合并：会话按 id 并集，消息按 id 并集；标题、分支选择等指针字段按时间戳 LWW，`writer` 兜底保证两端收敛。
- 触发：页面重新可见时拉取；回复结束后防抖推送；设置页提供手动同步。
- 并发：跨标签页用 Web Locks 互斥；提交前重读远端 head，必要时重合并重试。

## 6. 仓库格式

```text
manifest.json                 # 格式版本、数据世代、写入方与时间
sessions/{session_id}.json    # 完整会话，含全部消息与分支
tombstones/{session_id}.json  # 仅 { id, deletedAt }，永久保留
files/{sha256}                # 图片原件，内容寻址
```

`manifest.json`：

```json
{
  "format_version": 1,
  "epoch": "7c1f0b8e-…",
  "reset_at": "2026-11-17T10:00:00.000Z",
  "written_at": "2026-11-17T10:32:11.000Z",
  "writer": "device-uuid"
}
```

- `format_version` 不匹配时拒绝同步，提示升级应用，不写入任何数据。
- `epoch` 每次「删除所有对话」更换；`reset_at` 用于比较两端谁的重置更新。
- `writer` 是本设备持久化在 localStorage 的 UUID。

会话文件是一个包装结构，避免改本地消息模型：

```json
{
  "session": { "id": "…", "title": "…", "createdAt": 0, "updatedAt": 0, "messages": [] },
  "files": { "<file_id>": "<sha256>" }
}
```

- `session` 沿用本地 `Session` 结构（camelCase、毫秒时间戳），只新增两个字段：

| 位置 | 字段 | 含义 |
| --- | --- | --- |
| `Session` | `titleAt?: number` | 标题最后一次修改时间 |
| `Message`（分支字段） | `selectedAt?: number` | 该消息的 `selectedChildId` 最后一次切换时间 |

- `files` 是「附件 id → 内容哈希」索引，由同步层在推送时根据本地原件计算；本地没有原件的附件不出现在索引中。
- 删除状态不写进会话文件，由 `tombstones/` 表达，避免两处状态。

新增字段不进入现有历史 ZIP：`toArchive` 是显式字段映射，不会外泄。

## 7. 合并算法

### 7.1 会话集合

1. 按 `id` 求并集。
2. 任一端存在墓碑 → 结果为删除：删除内容文件、保留墓碑；墓碑的 `deletedAt` 取两端较小值，保证结果确定。
3. 只有一端且有内容 → 直接保留。
4. 两端都有内容 → 合并消息树。

### 7.2 消息与指针字段

```text
messages = unionById(local.messages, remote.messages) 按 createdAt 升序，相同时按 id 排序
同 id 防御性取舍：status 终态优先；blocks 取更长的一份
title            ← titleAt 较大者；相等按 writer 字典序
selectedChildId  ← 父消息 selectedAt 较大者；相等按 writer 字典序
```

`selectedChildId` 冲突的输家不会消失：两条子消息都在树里，界面继续用现有分支切换查看。

### 7.3 幂等与收敛

- 并集合并幂等：`merge(merge(a, b), b) = merge(a, b)`。
- 所有取舍规则只依赖数据本身和 `writer`，不依赖合并顺序，两端最终一致。
- 因此“force 覆盖提交”造成的竞态不会永久丢数据：被覆盖的一端下次同步会把自己的消息重新并入。

### 7.4 附件

- 推送时读取会话引用的本地原件，计算 SHA-256 写入会话文件的 `files` 索引；远端 `files/{sha256}` 已存在则跳过上传。
- 合并后按远端 `files` 索引找出本地缺失原件的附件 id，下载一次 blob 并分别写入这些 id（通常只有一个）。
- 附件 id 保持各端原值，不改写消息引用；同一内容在不同端可能有两个 id，但远端只存一份字节。

### 7.5 全局重置

`clearHistory` 清空本地数据时：

1. 生成新 `epoch`，记录 `lastResetAt = now`，清空 `pathShas`；
2. 推送新 manifest 与空树。

拉取时 `epoch` 不一致：

- 远端 `reset_at` 更新 → 弹确认「另一台设备清空了所有对话，是否跟随」；确认后清空本地会话、墓碑与附件（保留设置与 API Key），采用远端 epoch；拒绝则暂停自动同步，不推送，避免两端互相覆盖。
- 本地 `reset_at` 更新 → 忽略远端会话，直接以本地重置状态推送覆盖。

## 8. 同步流程

### 8.1 拉取

1. `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` 取 head（分支名按 URL 编码）；404 表示分支或仓库为空，按首次初始化处理。
2. head 等于本地 `lastCommitSha` → 拉取阶段结束（不下载任何文件），继续判断是否需要推送。
3. 取 tree（`recursive=1`）。分支存在但缺少 `manifest.json` → 视为仓库格式不完整，报错并停止，不写入。
4. 与本地 `pathShas` 对比，只下载变化的 `sessions/*.json` 与 `tombstones/*.json`。
5. 解析并校验；单个文件损坏只跳过并计数，不中断整次同步。
6. 内存中合并，经 `applySyncMerge()` 在单个 IndexedDB 事务中写会话、摘要、墓碑、附件与 `syncState`。
7. 下载合并结果中缺失的附件原件。

### 8.2 推送

1. 无本地改动（`dirty` 集合为空且合并未产生需要回写的差异）→ 跳过。
2. 重读 ref head，若与拉取时不同 → 重新拉取并合并，最多重试 3 次。
3. 计算变更路径：
   - `dirty` 中的会话写 `sessions/{id}.json`；
   - 新墓碑写 `tombstones/{id}.json`，同时删除对应的 `sessions/{id}.json`；
   - 会话 `files` 索引中本地存在、远端树缺失的图片上传为 `files/{sha256}`。
   - 删除远端路径用 `sha: null` 条目表示。
4. `POST /git/blobs` 上传新 blob（base64 分块编码，避免大文件时调用栈溢出）。
5. `POST /git/trees`（带 `base_tree`）→ `POST /git/commits`（parent 为当前 head）→ `PATCH /git/refs/heads/{branch}`（`force: true`）。
6. 保存新 head 与路径哈希表，清空 `dirty`。

首次初始化：`POST /git/trees`（无 `base_tree`）→ 无父提交的 commit → `POST /git/refs` 创建分支。

### 8.3 触发

自动触发仅在设置中开启「自动同步」且仓库、分支、Token 齐全时生效；手动同步不受开关限制。

| 触发 | 行为 |
| --- | --- |
| 页面 `visibilitychange` 变为可见 | 拉取 + 合并；有本地改动则继续推送 |
| 回复结束/停止/出错后 2 秒 | 推送（防抖） |
| 设置页「立即同步」 | 完整双向同步，显示进行中状态 |
| 触发时仍有回复在流式生成 | 记为待执行，等全部流结束后立即执行，不丢触发 |

写入入口统一在 `persist()` 中调用 `markDirty(sessionId)`；流式生成期间只标记不推送。

### 8.4 跨标签页互斥

使用 `navigator.locks.request('chat-demo-sync', { mode: 'exclusive' })` 串行化同一浏览器内的同步；不支持 Web Locks 的浏览器退化为仅进程内互斥。同步结束后通过 `BroadcastChannel('chat-demo-sync')` 通知其他标签刷新列表。

## 9. 模块与接口

新增 `src/services/sync/`：

```ts
// merge.ts —— 纯函数，无 IO
export type Tombstone = { id: string; deletedAt: number }
export type MergeStats = {
  sessionsAdded: number
  sessionsUpdated: number
  messagesAdded: number
  branchesAdded: number
  deletedSessions: number
}
export function mergeSessions(
  local: Session[],
  remote: Session[],
  tombstones: Tombstone[],
  writer: string
): { sessions: Session[]; tombstones: Tombstone[]; stats: MergeStats }

// snapshot.ts —— 序列化与校验
export type Manifest = {
  format_version: 1
  epoch: string
  reset_at: string
  written_at: string
  writer: string
}
export type SessionFile = { session: Session; files: Record<string, string> }
export function toSessionFile(session: Session, fileShas: Record<string, string>): string
export function fromSessionFile(text: string): SessionFile         // 失败抛 SyncFormatError
export function toManifest(value: Manifest): string
export function fromManifest(text: string): Manifest               // 版本不符抛 SyncFormatError
export function sha256Hex(blob: Blob): Promise<string>

// github.ts —— 只做 HTTP，不含业务判断
export type GitHubConfig = { owner: string; repo: string; branch: string; token: string }
export class GitHubClient {
  getHead(): Promise<string | null>
  getTree(treeSha: string): Promise<TreeEntry[]>
  getBlob(sha: string): Promise<Blob>
  getRepoSizeKb(): Promise<number>
  createBlob(blob: Blob): Promise<string>
  createTree(baseTree: string | null, entries: TreeEntryInput[]): Promise<string>
  createCommit(treeSha: string, parents: string[], message: string): Promise<string>
  updateRef(commitSha: string, force: boolean): Promise<void>
  createRef(commitSha: string): Promise<void>
}

// sync.ts —— 编排与状态
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled' | 'needs-confirm'
export function markDirty(sessionId: string): void
export function initSync(): () => void
export function syncNow(trigger: 'manual' | 'visible' | 'idle'): Promise<SyncResult>
export function confirmRemoteReset(): Promise<void>
```

边界原则：`merge.ts` 只依赖类型；`snapshot.ts` 不碰网络；`github.ts` 不读 IndexedDB；只有 `sync.ts` 同时接触存储、网络与 UI 状态。

## 10. 存储层改动

`db.ts`：

- `DB_VERSION` 11 → 12。
- 新增 `tombstones` store，`keyPath: 'id'`，值 `{ id: string; deletedAt: number }`。
- 新增 `syncState` store，单条记录 `id: 'state'`：

```ts
type SyncState = {
  lastCommitSha: string | null
  epoch: string
  lastResetAt: number
  pathShas: Record<string, string>   // 仓库路径 → blob sha，用于只下载变化文件
  lastSyncedAt: number
  lastError: string | null
}
```

- 升级只创建新 store，不迁移旧消息。

`store.ts`：

- `persist()` 末尾调用 `markDirty(sessionId)`。
- `removeSession`：删除前写墓碑，不再只做物理删除。
- `renameSession` 与自动生成标题处补充 `titleAt = Date.now()`。
- `selectMessageVersion`：切换时给父消息写 `selectedAt = Date.now()`。
- 新增 `applySyncMerge(result: MergeResult)`：单事务写入合并结果并刷新 `sessions` / `sessionCache`，其中 `MergeResult` 为 `mergeSessions` 的返回值加上待写入附件。
- 新增 `hasActiveStreams()` 供同步层判断是否可执行。

`settings.ts` 新增键（均只存本地，不参与同步）：

| 键 | 内容 |
| --- | --- |
| `chat-demo:sync-repo` | `owner/repo` |
| `chat-demo:sync-branch` | 分支名，默认 `main` |
| `chat-demo:sync-token` | fine-grained PAT |
| `chat-demo:sync-enabled` | 自动同步开关 |
| `chat-demo:sync-device` | 设备 UUID |

## 11. 设置与交互

设置 → 数据管理新增「跨设备同步」：

- 仓库、分支、Token 输入（Token 掩码显示，可清除）。
- 「立即同步」按钮与进行中状态。
- 上次同步时间、上次错误、未上传附件数量。
- 自动同步开关，默认关闭，配置完整后才可打开。
- 合并提示：仅两类场景弹 Toast（复用 `showToast`）——新增了分支，或会话被其他设备删除；其余静默。

Token 帮助文案说明：创建 fine-grained PAT，仅授权目标仓库，权限 `Contents: Read and write`。

## 12. 错误处理

| 情况 | 处理 |
| --- | --- |
| 网络失败、5xx | 保留本地状态，Toast 提示，下次触发重试 |
| 401 / 403 权限不足 | 暂停自动同步，设置页提示 Token 无效或权限不足 |
| 403 且 `X-RateLimit-Remaining: 0` | 等到 `X-RateLimit-Reset` 后再试，期间不再请求 |
| 提交时 ref 已变化 | 重新拉取合并，最多 3 次；仍失败则保留本地并提示稍后重试 |
| 单会话 JSON 损坏或字段非法 | 跳过该文件并计数，不删除本地数据 |
| 仓库超过 500MB | 只同步文本与元数据，提示跳过的图片数量 |
| 单文件超过 20MB | 跳过该附件，同上提示 |
| 拉取时正在流式生成 | 延后到无活跃流后执行 |
| 与导入/导出/清空同时发生 | 与 `backupQueue` 互斥，后到者等待 |

所有错误都不阻断聊天写入；同步是尽力而为的后台能力。

## 13. 安全与权限

- Token 与 API Key 同样存放在 localStorage，仅本机、仅当前 origin；同步数据中不包含 Token。
- 建议 fine-grained PAT，只授权单个私有仓库，权限最小化为 `Contents: Read and write`。
- 仓库内容为明文：GitHub 服务端、协作者与备份可读；`force` 覆盖后旧的 dangling commit 不保证立即被平台回收，因此「清空」不等于历史彻底删除。
- 需要更强隐私时启用第 14 节的加密扩展，其余逻辑不变。

## 14. 后续扩展：端到端加密

在 `snapshot.ts` 增加一层：口令经 PBKDF2 派生 AES-GCM 密钥，会话 JSON 与附件上传前加密，`files/{sha256}` 改为密文哈希，manifest 只存盐与 IV。仓库退化为不可读密文存储，此时公开仓库也可接受。本期不实现。

## 15. 已知取舍

| 取舍 | 影响 |
| --- | --- |
| 时间戳 LWW 依赖设备时钟 | 时钟偏差可能让较旧的标题/分支选择胜出；`writer` 兜底只保证收敛 |
| `force` 覆盖单分支 | 提交历史不保留；同时提交时需依赖并集合并自愈 |
| 墓碑永久保留 | 每条约 60 字节，可忽略；换来删除不会被旧设备复活 |
| 每会话一个文件 | 会话上千时单次同步请求数上升；用 path 哈希表把请求限制在变化文件 |
| 不同步设置与草稿 | 各端 UI 偏好独立，半截草稿不会互相覆盖 |
| 仅同步图片原件 | 非图片附件按现有导出策略只有元数据，跨设备打不开 |

## 16. 测试

单元测试（新增 `vitest` 与 `pnpm test`）：

- `merge.ts`：同会话两端新增消息、墓碑不复活、标题/分支选择 LWW、幂等、可交换、`writer` 决胜一致性。
- `snapshot.ts`：会话与 manifest 往返、非法字段与版本不匹配报错。
- `github.ts`：mock fetch 覆盖 401、403 限流、404 空分支、ref 冲突。

手工验收（两个浏览器配置文件，同一个私有仓库）：

1. 同一会话两端各聊两条 → 同步后两端都能切到对方分支，消息零丢失。
2. 连续同步两次 → 第二次不产生新提交。
3. A 端删除会话 → B 端同步后不复活。
4. 断网期间正常聊天 → 恢复后一次同步补齐。
5. 同一张图片只上传一次；两端都能预览。
6. A 端「删除所有对话」→ B 端提示并确认后跟随清空。
7. 导入/导出与同步同时操作 → 串行执行，无数据交错。

## 17. 实施顺序

1. 数据层：类型字段、`DB_VERSION` 12、`tombstones` / `syncState`、`persist` 标记、标题/分支时间戳。
2. `merge.ts` 与单测。
3. `snapshot.ts` 与单测。
4. `github.ts` 与 mock 单测。
5. `sync.ts` 编排 + 设置页手动同步（先跑通单次双向）。
6. 自动触发、Web Locks、Toast 与错误状态。
7. 手工验收与文档补充（README 增加同步说明）。
