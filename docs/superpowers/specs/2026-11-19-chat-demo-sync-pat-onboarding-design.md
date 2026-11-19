# chat-demo 同步配置向导设计

- 日期：2026-11-19
- 状态：待评审
- 范围：跨设备同步的仓库 / 分支 / Token 配置流程与连接校验，不改动合并、快照与推送逻辑

## 1. 背景

跨设备同步已实现，介质为用户自己的 GitHub 私有仓库，凭据为 fine-grained PAT。功能可用，但配置门槛偏高：

1. 用户需要自行理解 fine-grained PAT 的仓库选择与 `Contents: Read and write` 权限。
2. 仓库输入只接受 `owner/repo`，从浏览器地址栏复制来的 URL 无法直接使用。
3. 所有错误都直接展示 GitHub 返回的英文 `message`，无法区分「Token 无效」「仓库不存在」「无权限」。
4. 没有引导入口，用户不知道先建仓库还是先建 Token。
5. Token 过期后才会在同步时失败，缺少提前提示。

本方案只优化「从零配置到第一次同步成功」的路径，同步协议与数据格式不变。

## 2. 目标

1. 新用户能在设置页按三步说明完成配置，不必查阅外部文档。
2. 粘贴仓库 URL、Token 后立即得到明确结果：连接成功、仓库公开、或具体失败原因。
3. Token 临近过期和已过期时提前提示，已过期不再发起无效请求。
4. 不引入 OAuth 应用、不引入后端、不改变现有安全边界。

## 3. 非目标

- GitHub OAuth Device Flow 一键授权（需要注册 OAuth App，且只能申请 classic `repo` 全量私有仓库权限）。
- 自动创建仓库：fine-grained Token 需 `Administration: write` 才能建仓库，不做。
- GitLab / Gitee / WebDAV 等其他存储后端。
- 修改同步算法、快照格式、Git Data API 调用顺序。

## 4. 输入解析

新增纯函数 `parseRepoInput(value: string)`，返回 `{ owner: string; repo: string } | null`。

- 接受 `owner/repo`、`https://github.com/owner/repo`、`https://github.com/owner/repo.git`。
- 去掉首尾空白、末尾 `/`、`.git` 后缀与 URL 的查询串。
- 仅接受 `github.com`；其他域名返回 `null`，界面提示「仅支持 GitHub」。
- 输入框失焦时归一化为 `owner/repo` 写入设置，之后所有代码继续使用现有格式。

## 5. 连接校验

### 5.1 GitHub 客户端

`GitHubClient` 增加只读方法：

```ts
getRepo(): Promise<{ private: boolean; defaultBranch: string }>
```

请求层在每次响应后记录 `github-authentication-token-expiration` 响应头，暴露：

```ts
getTokenExpiresAt(): number | null
```

该值仅用于展示与跳过过期请求，不参与同步判断。

### 5.2 校验流程

新增 `validateSyncTarget()`（`sync.ts`）：

1. 检查 `owner/repo`、分支、Token 是否齐全，不齐全直接返回配置错误。
2. `GET /repos/{owner}/{repo}` 判断仓库是否可访问。
3. `getHead()` 判断分支是否存在；分支不存在属正常情况，首次推送会 `createRef`。
4. 返回 `{ ok, private, branchExists, tokenExpiresAt }` 或抛出具象错误。

GitHub 对「仓库不存在」与「Token 无权限」都返回 404，因此文案统一为「仓库不存在或 Token 无权访问」，不做猜测。

## 6. 设置页交互

### 6.1 空态向导

仓库为空且没有 Token 时，在现有字段上方显示三步说明：

1. 新建私有仓库（链接 `https://github.com/new?name=chat-demo-data&visibility=private`）。
2. 创建 fine-grained Token（链接 `https://github.com/settings/personal-access-tokens/new`），说明只勾选该仓库的 `Contents: Read and write`。
3. 粘贴 Token 并点击「验证连接」。

已填写任意一项后隐藏向导，避免长期占据空间。

### 6.2 校验时机

- Token 失焦且仓库、分支格式合法时自动校验一次。
- 保留显式「验证连接」按钮，展示「校验中 / 已连接 / 失败原因」。
- 校验只读，不写远端；不改变 `syncState`。

### 6.3 公开仓库警告

校验发现 `private === false` 时显示黄色提示：对话与图片将对任何能访问该仓库的人可见。仅提示，不阻止同步。

### 6.4 错误映射

按 `GitHubError.kind` 映射为界面文案：

| kind | 文案 |
| --- | --- |
| `auth` | Token 无效或已过期 |
| `not-found` | 仓库不存在或 Token 无权访问 |
| `rate-limit` | 请求过于频繁，`resetAt` 之后重试 |
| `network` | 网络不可达，请检查代理或网络 |
| `server` / `protocol` | GitHub 服务异常，稍后重试 |

`useSyncStatus` 增加内存字段 `lastErrorKind`；有值时按语言实时翻译，无值时回退到持久化的原始 `lastError` 文本。

## 7. Token 过期

- settings 新增 `syncTokenExpiresAt: number | null`，键 `chat-demo:sync-token-expiry`，仅本机保存。
- 清除 Token 时一并清空。
- 剩余不足 7 天：设置页黄色提示过期时间。
- 已过期：红色提示；自动同步在发请求前直接跳过，标记为 `error`。
- 无过期响应头（classic token）时不提示。

## 8. 影响文件

| 文件 | 变更 |
| --- | --- |
| `src/services/sync/repoInput.ts`（新增） | `parseRepoInput()` |
| `src/services/sync/github.ts` | `getRepo()`、Token 过期时间读取 |
| `src/services/sync/sync.ts` | `validateSyncTarget()`、错误映射、过期跳过 |
| `src/services/settings.ts` | `syncTokenExpiresAt` 及 setter |
| `src/components/settings/SettingsDialog.tsx` | 向导、校验按钮与状态、警告与错误展示 |
| `src/components/settings/Settings.module.css(.d.ts)` | 向导与提示样式 |
| `src/i18n/zh.ts`、`src/i18n/en.ts` | 新增文案 |
| `README.md`、`README.zh-CN.md` | 配置步骤补充直达链接与校验说明 |

## 9. 测试

- `parseRepoInput`：四种输入形式、非法域名、带查询串、空值。
- `github.getRepo`：mock `fetch` 校验请求头、`private` 解析与过期响应头读取。
- `validateSyncTarget`：仓库 404、分支不存在、Token 过期三种分支。
- 手动验证：空态向导、URL 归一化、公开仓库警告、错误文案中英文切换、过期提示。

## 10. 风险与取舍

- 自动校验会在失焦时额外产生 2 次 API 请求；仅在仓库与 Token 均合法且值发生变化时触发，可接受。
- `github-authentication-token-expiration` 仅 fine-grained Token 返回；classic Token 无法预知过期时间，只能等同步失败。
- 公开仓库警告是提醒而非阻断，用户仍可选择继续。
