import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { createId } from '../../utils/id.js'
import { enqueueBackup } from '../chat/backupQueue.js'
import * as db from '../chat/db.js'
import {
  applyRemoteReset,
  applySyncMerge,
  flushSessions,
  hasActiveStreams,
  refreshSessions,
  useChatStore,
} from '../chat/store.js'
import type { Session } from '../chat/types.js'
import { setSyncTokenExpiresAt, useSettings } from '../settings.js'
import { clearAllDirty, clearDirty, dirtySnapshot, markAllDirty } from './dirty.js'
import {
  GitHubClient,
  GitHubError,
  type GitHubErrorKind,
  type TreeEntry,
  type TreeEntryInput,
} from './github.js'
import { mergeSessions, type MergeStats, type Tombstone } from './merge.js'
import { parseRepoInput } from './repoInput.js'
import {
  fromManifest,
  fromSessionFile,
  sha256Hex,
  SyncFormatError,
  toManifest,
  toSessionFile,
  type Manifest,
} from './snapshot.js'

export { markDirty, markAllDirty } from './dirty.js'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled' | 'needs-confirm'

export type SyncResult = {
  status: SyncStatus
  pulled: boolean
  pushed: boolean
  skippedFiles: number
  stats?: MergeStats
}

type SyncUiState = {
  status: SyncStatus
  lastSyncedAt: number | null
  lastError: string | null
  /** 上次同步发现、但本机没有原件（或超限跳过）的图片数量。 */
  pendingFiles: number
  needsConfirm: boolean
  /** 失败原因分类，仅保留在内存中，用于按当前语言展示；刷新后回退到 lastError。 */
  lastErrorKind: GitHubErrorKind | null
}

export const useSyncStatus = create<SyncUiState>(() => ({
  status: 'idle',
  lastSyncedAt: null,
  lastError: null,
  pendingFiles: 0,
  needsConfirm: false,
  lastErrorKind: null,
}))

type SyncConfig = {
  owner: string
  repo: string
  branch: string
  token: string
  device: string
}

const readConfig = (): SyncConfig | null => {
  const { syncRepo, syncBranch, syncToken, syncDevice } = useSettings.getState()
  const target = parseRepoInput(syncRepo)
  const token = syncToken?.trim() ?? ''
  if (!target || !token) {
    return null
  }
  return {
    owner: target.owner,
    repo: target.repo,
    branch: syncBranch.trim() || 'main',
    token,
    device: syncDevice,
  }
}

const isAutoEnabled = () => useSettings.getState().syncEnabled && readConfig() !== null

export type SyncTargetCheck = {
  owner: string
  repo: string
  private: boolean
  /** 分支不存在属正常：首次推送会创建。 */
  branchExists: boolean
  tokenExpiresAt: number | null
}

/** 只读校验当前配置：仓库是否可访问、是否公开、分支是否存在，并记录 Token 过期时间。 */
export const validateSyncTarget = async (): Promise<SyncTargetCheck> => {
  const config = readConfig()
  if (!config) {
    throw new Error('sync target is not configured')
  }
  const client = new GitHubClient(config)
  const repo = await client.getRepo()
  const head = await client.getHead()
  const tokenExpiresAt = client.getTokenExpiresAt()
  setSyncTokenExpiresAt(tokenExpiresAt)
  return {
    owner: config.owner,
    repo: config.repo,
    private: repo.private,
    branchExists: head !== null,
    tokenExpiresAt,
  }
}

/** 认证失败后暂停自动同步，等用户修正 Token 或手动同步。 */
let authPaused = false
/** 限流解除时间，期间不再发起请求。 */
let rateLimitedUntil = 0
let running: Promise<SyncResult> | null = null
let queued = false
let broadcast: BroadcastChannel | null = null
let idleTimer = 0

/** 对象键顺序不同的同构数据序列化结果一致，用于判断会话是否真的变化。 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const waitForStreams = (): Promise<void> => {
  if (!hasActiveStreams()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (Object.keys(state.streaming).length === 0) {
        unsubscribe()
        resolve()
      }
    })
  })
}

const pathShasFrom = (entries: TreeEntry[]): Record<string, string> =>
  Object.fromEntries(
    entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha])
  )

const isSessionPath = (path: string) => path.startsWith('sessions/') && path.endsWith('.json')
const isTombstonePath = (path: string) => path.startsWith('tombstones/') && path.endsWith('.json')

type PullOutcome = {
  head: string | null
  treeSha: string | null
  entries: TreeEntry[]
  reset: 'remote' | 'local' | null
  /** 采用远端或本地世代后的同步状态。 */
  epoch: string
  lastResetAt: number
  pathShas: Record<string, string>
  stats?: MergeStats
  skippedFiles: number
}

type PendingReset = {
  head: string
  treeSha: string
  entries: TreeEntry[]
  manifest: Manifest
}

let pendingReset: PendingReset | null = null

/** 推送期间远端 head 变化；由上层重新拉取合并后重试。 */
class RefConflictError extends Error {
  override name = 'RefConflictError'
}

/**
 * 拉取远端变化并合并到本地。
 * head 未变化时直接返回；远端全局重置更新时停在 needs-confirm；
 * 本地重置更新时忽略远端内容，交由推送阶段清空远端。
 */
const pull = async (
  client: GitHubClient,
  state: db.SyncState,
  config: SyncConfig
): Promise<PullOutcome> => {
  const head = await client.getHead()
  if (!head) {
    return {
      head: null,
      treeSha: null,
      entries: [],
      reset: null,
      epoch: state.epoch,
      lastResetAt: state.lastResetAt,
      pathShas: state.pathShas,
      skippedFiles: 0,
    }
  }
  if (head === state.lastCommitSha) {
    return {
      head,
      treeSha: null,
      entries: [],
      reset: null,
      epoch: state.epoch,
      lastResetAt: state.lastResetAt,
      pathShas: state.pathShas,
      skippedFiles: 0,
    }
  }

  const commit = await client.getCommit(head)
  const entries = await client.getTree(commit.treeSha)
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json')
  if (!manifestEntry) {
    throw new SyncFormatError('仓库缺少 manifest.json，可能不是本应用的数据仓库')
  }
  const manifest = fromManifest(await (await client.getBlob(manifestEntry.sha)).text())

  let adopted = state
  if (!state.epoch) {
    // 首次同步到已有仓库：采用远端世代，把本地数据并入。
    adopted = {
      ...state,
      epoch: manifest.epoch,
      lastResetAt: Date.parse(manifest.reset_at),
    }
  } else if (manifest.epoch !== state.epoch) {
    if (Date.parse(manifest.reset_at) > state.lastResetAt) {
      pendingReset = { head, treeSha: commit.treeSha, entries, manifest }
      return {
        head,
        treeSha: commit.treeSha,
        entries,
        reset: 'remote',
        epoch: state.epoch,
        lastResetAt: state.lastResetAt,
        pathShas: state.pathShas,
        skippedFiles: 0,
      }
    }
    // 本地重置更晚：忽略远端会话，推送阶段清空远端。
    return {
      head,
      treeSha: commit.treeSha,
      entries,
      reset: 'local',
      epoch: state.epoch,
      lastResetAt: state.lastResetAt,
      pathShas: pathShasFrom(entries),
      skippedFiles: 0,
    }
  }

  return pullChanges(client, adopted, config, head, commit.treeSha, entries)
}

const pullChanges = async (
  client: GitHubClient,
  state: db.SyncState,
  config: SyncConfig,
  head: string,
  treeSha: string,
  entries: TreeEntry[]
): Promise<PullOutcome> => {
  const pathShas = pathShasFrom(entries)
  const remoteSessions: Session[] = []
  const remoteTombstones: Tombstone[] = []
  const remoteFiles = new Map<string, Record<string, string>>()
  let skippedFiles = 0

  for (const entry of entries) {
    if (!isSessionPath(entry.path) || state.pathShas[entry.path] === entry.sha) {
      continue
    }
    try {
      const file = fromSessionFile(await (await client.getBlob(entry.sha)).text())
      remoteSessions.push(file.session)
      remoteFiles.set(file.session.id, file.files)
    } catch {
      // 单个文件损坏只跳过，不中断整次同步。
      skippedFiles += 1
    }
  }
  for (const entry of entries) {
    if (!isTombstonePath(entry.path) || state.pathShas[entry.path] === entry.sha) {
      continue
    }
    try {
      const parsed = JSON.parse(await (await client.getBlob(entry.sha)).text()) as Tombstone
      if (typeof parsed.id === 'string' && typeof parsed.deletedAt === 'number') {
        remoteTombstones.push(parsed)
      }
    } catch {
      skippedFiles += 1
    }
  }

  const localSessions = await db.loadAllSessions()
  const localTombstones = await db.loadTombstones()
  const result = mergeSessions(
    localSessions,
    remoteSessions,
    [...localTombstones, ...remoteTombstones],
    config.device
  )
  const localById = new Map(localSessions.map((session) => [session.id, session]))
  const mergedIds = new Set(result.sessions.map((session) => session.id))
  const changed = result.sessions.filter((session) => {
    const local = localById.get(session.id)
    return !local || canonical(local) !== canonical(session)
  })
  const deleteSessionIds = localSessions
    .filter((session) => !mergedIds.has(session.id))
    .map((session) => session.id)

  const files = await downloadFiles(client, result.sessions, remoteFiles, (count) => {
    skippedFiles += count
  })

  await applySyncMerge({
    sessions: changed,
    deleteSessionIds,
    tombstones: result.tombstones,
    files,
    syncState: {
      ...state,
      lastCommitSha: head,
      pathShas,
      lastSyncedAt: Date.now(),
      lastError: null,
    },
  })

  return {
    head,
    treeSha,
    entries,
    reset: null,
    epoch: state.epoch,
    lastResetAt: state.lastResetAt,
    pathShas,
    stats: result.stats,
    skippedFiles,
  }
}

/** 下载本地缺失的图片原件；同一内容的多个附件 id 共用一次下载。 */
const downloadFiles = async (
  client: GitHubClient,
  sessions: Session[],
  remoteFiles: Map<string, Record<string, string>>,
  addSkipped: (count: number) => void
): Promise<db.StoredFile[]> => {
  const missing = new Map<string, string>()
  for (const session of sessions) {
    const index = remoteFiles.get(session.id)
    if (!index) {
      continue
    }
    for (const [fileId, sha] of Object.entries(index)) {
      if (!(await db.loadFile(fileId))) {
        missing.set(fileId, sha)
      }
    }
  }
  if (missing.size === 0) {
    return []
  }
  if ((await client.getRepoSizeKb()) > 500 * 1024) {
    addSkipped(missing.size)
    return []
  }
  const blobs = new Map<string, Blob>()
  const files: db.StoredFile[] = []
  for (const [fileId, sha] of missing) {
    let blob = blobs.get(sha)
    if (!blob) {
      blob = await client.getBlob(sha)
      blobs.set(sha, blob)
    }
    if (blob.size > 20 * 1024 * 1024) {
      addSkipped(1)
      continue
    }
    files.push({ id: fileId, blob })
  }
  return files
}

type PushOutcome = {
  pushed: boolean
  pendingFiles: number
  commitSha: string | null
  pathShas: Record<string, string>
}

/** 推送本机待同步会话与墓碑；每次同步最多产生一个提交。 */
const push = async (
  client: GitHubClient,
  state: db.SyncState,
  config: SyncConfig,
  head: string | null,
  treeSha: string | null,
  remoteEntries: TreeEntry[],
  forceReset: boolean
): Promise<PushOutcome> => {
  await flushSessions()
  const dirty = new Set(dirtySnapshot())
  const localSessions = await db.loadAllSessions()
  const localById = new Map(localSessions.map((session) => [session.id, session]))
  const tombstones = forceReset ? [] : await db.loadTombstones()
  // 已删除会话的待推送标记不再有意义；墓碑本身会单独上传。
  clearDirty(dirtySnapshot().filter((id) => !localById.has(id)))
  const sessionIds = localSessions
    .filter((session) => dirty.has(session.id))
    .map((session) => session.id)

  const remotePaths = { ...state.pathShas }
  if (forceReset) {
    for (const entry of remoteEntries) {
      if (isSessionPath(entry.path) || isTombstonePath(entry.path)) {
        remotePaths[entry.path] = entry.sha
      }
    }
  }

  const entries: TreeEntryInput[] = []
  const blobs: { path: string; blob: Blob }[] = []
  const queuedPaths = new Set<string>()
  let pendingFiles = 0
  let skipAttachments = false
  let attachmentBudgetChecked = false

  const addBlob = (path: string, blob: Blob) => {
    if (queuedPaths.has(path)) {
      return
    }
    queuedPaths.add(path)
    blobs.push({ path, blob })
  }

  for (const id of sessionIds) {
    const session = localById.get(id)
    if (!session) {
      continue
    }
    const fileShas: Record<string, string> = {}
    const imageIds = new Set(
      session.messages.flatMap((message) =>
        message.role === 'user'
          ? message.files.filter((file) => file.isImage).map((file) => file.id)
          : []
      )
    )
    for (const fileId of imageIds) {
      const blob = await db.loadFile(fileId)
      if (!blob) {
        pendingFiles += 1
        continue
      }
      if (blob.size > 20 * 1024 * 1024) {
        pendingFiles += 1
        continue
      }
      if (!attachmentBudgetChecked) {
        attachmentBudgetChecked = true
        skipAttachments = (await client.getRepoSizeKb()) > 500 * 1024
      }
      if (skipAttachments) {
        pendingFiles += 1
        continue
      }
      const sha = await sha256Hex(blob)
      fileShas[fileId] = sha
      if (!remotePaths[`files/${sha}`]) {
        addBlob(`files/${sha}`, blob)
      }
    }
    addBlob(
      `sessions/${id}.json`,
      new Blob([toSessionFile(session, fileShas)], { type: 'application/json' })
    )
  }

  for (const tombstone of tombstones) {
    const path = `tombstones/${tombstone.id}.json`
    if (!remotePaths[path]) {
      addBlob(path, new Blob([JSON.stringify(tombstone)], { type: 'application/json' }))
    }
    const sessionPath = `sessions/${tombstone.id}.json`
    if (remotePaths[sessionPath]) {
      entries.push({ path: sessionPath, mode: '100644', type: 'blob', sha: null })
    }
  }

  if (forceReset && remoteEntries.length > 0) {
    for (const entry of remoteEntries) {
      if (isSessionPath(entry.path) || isTombstonePath(entry.path)) {
        entries.push({ path: entry.path, mode: '100644', type: 'blob', sha: null })
      }
    }
  }

  if (blobs.length === 0 && entries.length === 0) {
    return { pushed: false, pendingFiles, commitSha: head, pathShas: state.pathShas }
  }

  const epoch = state.epoch || createId()
  const lastResetAt = state.epoch ? state.lastResetAt : Date.now()
  const manifest: Manifest = {
    format_version: 1,
    epoch,
    reset_at: new Date(lastResetAt).toISOString(),
    written_at: new Date().toISOString(),
    writer: config.device,
  }
  addBlob('manifest.json', new Blob([toManifest(manifest)], { type: 'application/json' }))

  const uploaded: Record<string, string> = {}
  for (const { path, blob } of blobs) {
    const sha = await client.createBlob(blob)
    uploaded[path] = sha
    entries.push({ path, mode: '100644', type: 'blob', sha })
  }

  // 提交前确认分支没有被别的设备更新；有变化则交给上层重新拉取合并。
  if ((await client.getHead()) !== head) {
    throw new RefConflictError('remote branch moved during sync')
  }

  const baseTree = treeSha ?? (head ? (await client.getCommit(head)).treeSha : null)
  const newTree = await client.createTree(baseTree, entries)
  const commitSha = await client.createCommit(
    newTree,
    head ? [head] : [],
    `sync: ${new Date().toISOString()}`
  )
  if (head) {
    await client.updateRef(commitSha, true)
  } else {
    await client.createRef(commitSha)
  }

  const nextPaths = { ...remotePaths, ...uploaded }
  const deletedPaths = new Set(
    entries.filter((entry) => entry.sha === null).map((entry) => entry.path)
  )
  const remainingPaths = Object.fromEntries(
    Object.entries(nextPaths).filter(([path]) => !deletedPaths.has(path))
  )
  clearDirty([...sessionIds, ...tombstones.map((tombstone) => tombstone.id)])
  return { pushed: true, pendingFiles, commitSha, pathShas: remainingPaths }
}

const handleError = async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof GitHubError) {
    if (error.kind === 'auth') {
      authPaused = true
    }
    if (error.kind === 'rate-limit') {
      rateLimitedUntil = error.resetAt ?? Date.now() + 60_000
    }
  }
  useSyncStatus.setState({
    status: 'error',
    lastError: message,
    lastErrorKind: error instanceof GitHubError ? error.kind : null,
  })
  // 重新读取状态再写入错误，避免覆盖拉取阶段已保存的 head 与路径表。
  const current = await db.loadSyncState().catch(() => null)
  if (current) {
    await db.saveSyncState({ ...current, lastError: message }).catch(() => {})
  }
  showToast({ key: 'syncFailed', type: 'error' })
}

const notifySynced = (stats?: MergeStats, skippedFiles = 0) => {
  if (stats?.branchesAdded) {
    showToast({ key: 'syncMergedBranches', params: { count: stats.branchesAdded } })
  } else if (stats?.deletedSessions) {
    showToast({ key: 'syncMergedDeleted', params: { count: stats.deletedSessions } })
  } else if (skippedFiles > 0) {
    showToast({ key: 'syncSkippedFiles', params: { count: skippedFiles } })
  }
  broadcast?.postMessage('synced')
}

const runSync = async (trigger: 'manual' | 'visible' | 'idle'): Promise<SyncResult> => {
  const config = readConfig()
  if (!config || (trigger !== 'manual' && !isAutoEnabled())) {
    useSyncStatus.setState({ status: 'disabled' })
    return { status: 'disabled', pulled: false, pushed: false, skippedFiles: 0 }
  }
  if (trigger !== 'manual' && authPaused) {
    return { status: 'error', pulled: false, pushed: false, skippedFiles: 0 }
  }
  if (trigger !== 'manual' && Date.now() < rateLimitedUntil) {
    return { status: 'error', pulled: false, pushed: false, skippedFiles: 0 }
  }
  const tokenExpiresAt = useSettings.getState().syncTokenExpiresAt
  if (trigger !== 'manual' && tokenExpiresAt !== null && tokenExpiresAt <= Date.now()) {
    // Token 已过期，自动同步直接停下，避免每次触发都发一轮必然失败的请求。
    useSyncStatus.setState({ status: 'error', lastError: 'Token expired', lastErrorKind: 'auth' })
    return { status: 'error', pulled: false, pushed: false, skippedFiles: 0 }
  }
  if (trigger === 'manual') {
    authPaused = false
  }
  useSyncStatus.setState({ status: 'syncing', lastError: null, lastErrorKind: null })
  try {
    await flushSessions()
    const client = new GitHubClient(config)
    // 推送前发现远端 head 变化时，重新拉取合并并重试，最多 3 次。
    for (let attempt = 1; ; attempt += 1) {
      const state = await db.loadSyncState()
      if (!state.epoch && state.lastCommitSha === null) {
        // 首次同步或切换了仓库：把现有本地会话全部推送到远端。
        markAllDirty((await db.loadAllSessions()).map((session) => session.id))
      }
      const pulled = await pull(client, state, config)
      if (pulled.reset === 'remote') {
        useSyncStatus.setState({ status: 'needs-confirm', needsConfirm: true })
        return { status: 'needs-confirm', pulled: false, pushed: false, skippedFiles: 0 }
      }
      const baseState: db.SyncState = {
        ...state,
        epoch: pulled.epoch || createId(),
        lastResetAt: pulled.epoch ? pulled.lastResetAt : Date.now(),
        pathShas: pulled.pathShas,
      }
      try {
        const pushed = await push(
          client,
          baseState,
          config,
          pulled.head,
          pulled.treeSha,
          pulled.entries,
          pulled.reset === 'local'
        )
        const nextState: db.SyncState = {
          ...baseState,
          lastCommitSha: pushed.commitSha,
          pathShas: pushed.pathShas,
          lastSyncedAt: Date.now(),
          lastError: null,
        }
        await db.saveSyncState(nextState)
        // 同步过程中也能拿到过期时间，顺手更新，避免用户没点「验证连接」时缺少提醒。
        const expiresAt = client.getTokenExpiresAt()
        if (expiresAt !== null) {
          setSyncTokenExpiresAt(expiresAt)
        }
        useSyncStatus.setState({
          status: 'idle',
          lastSyncedAt: nextState.lastSyncedAt,
          lastError: null,
          lastErrorKind: null,
          pendingFiles: pushed.pendingFiles,
          needsConfirm: false,
        })
        notifySynced(pulled.stats, pulled.skippedFiles)
        return {
          status: 'idle',
          pulled: pulled.head !== null && pulled.treeSha !== null,
          pushed: pushed.pushed,
          skippedFiles: pulled.skippedFiles,
          stats: pulled.stats,
        }
      } catch (error) {
        if (error instanceof RefConflictError && attempt < 3) {
          continue
        }
        throw error
      }
    }
  } catch (error) {
    await handleError(error)
    return { status: 'error', pulled: false, pushed: false, skippedFiles: 0 }
  }
}

/** 同一浏览器内用 Web Locks 串行化同步；不支持时退化为进程内互斥。 */
const withLock = <T>(run: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks?.request) {
    return locks.request('chat-demo-sync', { mode: 'exclusive' }, run) as Promise<T>
  }
  return run()
}

export const syncNow = (trigger: 'manual' | 'visible' | 'idle' = 'manual'): Promise<SyncResult> => {
  if (running) {
    queued = true
    return running
  }
  running = (async () => {
    // 先等流式回复结束，再进入备份队列和 Web Lock，避免长时间占用阻塞导入/导出。
    await waitForStreams()
    return withLock(() => enqueueBackup(() => runSync(trigger)))
  })().finally(() => {
    running = null
    if (queued) {
      queued = false
      void syncNow('idle')
    }
  })
  return running
}

/** 跟随远端全局重置：清空本地会话与附件，采用远端世代。 */
export const confirmRemoteReset = async (): Promise<void> => {
  if (!pendingReset) {
    return
  }
  const { manifest, head, entries } = pendingReset
  pendingReset = null
  useSyncStatus.setState({ status: 'syncing' })
  // 与导入/导出/删除共用备份队列，避免同时改写本地数据。
  await enqueueBackup(async () => {
    await applyRemoteReset({
      id: db.SYNC_STATE_ID,
      lastCommitSha: head,
      epoch: manifest.epoch,
      lastResetAt: Date.parse(manifest.reset_at),
      pathShas: pathShasFrom(entries),
      lastSyncedAt: Date.now(),
      lastError: null,
    })
  })
  useSyncStatus.setState({
    status: 'idle',
    lastSyncedAt: Date.now(),
    needsConfirm: false,
    lastError: null,
  })
  broadcast?.postMessage('synced')
}

/** 拒绝跟随远端重置：暂停自动同步，避免两端互相覆盖。 */
export const dismissRemoteReset = () => {
  pendingReset = null
  authPaused = true
  useSyncStatus.setState({ status: 'error', needsConfirm: false, lastError: null })
}

/** 本地「删除所有对话」后生成新世代，下一次同步清空远端。 */
export const handleLocalReset = async (): Promise<void> => {
  clearAllDirty()
  await db.clearAllLocalData()
  const state = await db.loadSyncState()
  await db.saveSyncState({
    ...state,
    epoch: createId(),
    lastResetAt: Date.now(),
    pathShas: {},
    lastCommitSha: null,
    lastSyncedAt: 0,
    lastError: null,
  })
  useSyncStatus.setState({ status: 'idle', needsConfirm: false, lastError: null })
  if (isAutoEnabled()) {
    void syncNow('idle')
  }
}

/** 仓库或分支改变后丢弃旧的路径缓存，下一次同步按首次处理。 */
export const resetSyncTarget = async (): Promise<void> => {
  const state = await db.loadSyncState()
  await db.saveSyncState({
    ...state,
    lastCommitSha: null,
    pathShas: {},
    epoch: '',
    lastResetAt: 0,
    lastError: null,
  })
  useSyncStatus.setState({ lastError: null, status: 'idle', needsConfirm: false })
}

/** 初始化自动触发；返回清理函数。 */
export const initSync = (): (() => void) => {
  void db.loadSyncState().then((state) => {
    useSyncStatus.setState({
      lastSyncedAt: state.lastSyncedAt || null,
      lastError: state.lastError,
    })
  })

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && isAutoEnabled()) {
      void syncNow('visible')
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  // 回复结束 2 秒后推送；期间又有回复开始则重新计时。
  let streaming = false
  const unsubscribe = useChatStore.subscribe((state) => {
    const active = Object.keys(state.streaming).length > 0
    if (active) {
      streaming = true
      window.clearTimeout(idleTimer)
      idleTimer = 0
      return
    }
    if (streaming) {
      streaming = false
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        idleTimer = 0
        if (isAutoEnabled()) {
          void syncNow('idle')
        }
      }, 2000)
    }
  })

  // Token 修正后恢复自动同步。
  const unsubscribeSettings = useSettings.subscribe((state, previous) => {
    if (state.syncToken !== previous.syncToken) {
      authPaused = false
    }
  })

  if (typeof BroadcastChannel !== 'undefined') {
    broadcast = new BroadcastChannel('chat-demo-sync')
    broadcast.onmessage = () => {
      void refreshSessions()
    }
  }

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    unsubscribe()
    unsubscribeSettings()
    window.clearTimeout(idleTimer)
    idleTimer = 0
    broadcast?.close()
    broadcast = null
  }
}
