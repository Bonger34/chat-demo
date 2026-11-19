import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Tombstone } from '../sync/merge.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 12

/** 同步状态固定为单条记录，便于整条读写。 */
export type SyncState = {
  id: 'state'
  /** 上次同步使用的远端 head，用于跳过未变化的拉取。 */
  lastCommitSha: string | null
  /** 数据世代；「删除所有对话」后更换。 */
  epoch: string
  /** 本地最近一次全局重置的时间，毫秒。 */
  lastResetAt: number
  /** 仓库路径 → blob sha，用于只下载变化文件。 */
  pathShas: Record<string, string>
  lastSyncedAt: number
  lastError: string | null
}

export const SYNC_STATE_ID = 'state' as const

export const emptySyncState = (): SyncState => ({
  id: SYNC_STATE_ID,
  lastCommitSha: null,
  epoch: '',
  lastResetAt: 0,
  pathShas: {},
  lastSyncedAt: 0,
  lastError: null,
})

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 已删除会话的墓碑；永久保留，避免旧设备把删除的会话重新同步回来。 */
  tombstones: { key: string; value: Tombstone }
  /** 跨设备同步的本地状态。 */
  syncState: { key: string; value: SyncState }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'sessionsStaging',
        'filesStaging',
        'tombstones',
        'syncState',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          // 同步时按时间戳合并标题，重命名必须留下时间。
          session.titleAt = Date.now()
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。墓碑与删除在同一事务中写入。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'tombstones'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        await tx.objectStore('tombstones').put({ id: sessionId, deletedAt: Date.now() })
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 同步写入所需的全部数据；一次事务落盘，避免合并结果只写入一半。 */
export type SyncWrite = {
  /** 需要新增或更新的会话。 */
  sessions: Session[]
  /** 需要删除的会话 id（已被墓碑标记或被远端合并移除）。 */
  deleteSessionIds: string[]
  /** 墓碑并集；只新增/覆盖，不删除已有记录。 */
  tombstones: Tombstone[]
  files: StoredFile[]
  syncState: SyncState
}

export const loadAllSessions = async (): Promise<Session[]> => (await getDB()).getAll('sessions')

export const loadTombstones = async (): Promise<Tombstone[]> => (await getDB()).getAll('tombstones')

export const loadSyncState = async (): Promise<SyncState> =>
  (await (await getDB()).get('syncState', SYNC_STATE_ID)) ?? emptySyncState()

export const saveSyncState = async (syncState: SyncState): Promise<void> => {
  await (await getDB()).put('syncState', syncState)
}

/** 单事务写入同步结果：会话、摘要、删除、墓碑、附件与同步状态一起提交。 */
export const applySyncWrite = async ({
  sessions,
  deleteSessionIds,
  tombstones,
  files,
  syncState,
}: SyncWrite): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'tombstones', 'syncState'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const sessionStore = tx.objectStore('sessions')
        const summaries = tx.objectStore('sessionSummaries')
        const deletedFileIds = new Set<string>()
        for (const id of deleteSessionIds) {
          const summary = await summaries.get(id)
          await sessionStore.delete(id)
          await summaries.delete(id)
          // 记下被删会话引用的附件，稍后确认没有其他会话引用再清理。
          for (const fileId of summary?.fileIds ?? []) {
            deletedFileIds.add(fileId)
          }
        }
        for (const session of sessions) {
          await sessionStore.put(session)
          await summaries.put(storedSummary(session))
        }
        for (const tombstone of tombstones) {
          await tx.objectStore('tombstones').put(tombstone)
        }
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        for (const fileId of deletedFileIds) {
          if ((await summaries.index('fileIds').count(fileId)) === 0) {
            await tx.objectStore('files').delete(fileId)
          }
        }
        await tx.objectStore('syncState').put(syncState)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 跟随远端全局重置：清空会话与附件，保留设置与 API Key。 */
export const clearAllLocalData = async (): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'tombstones'],
    'readwrite'
  )
  await Promise.all([
    async () => {
      await Promise.all([
        tx.objectStore('sessions').clear(),
        tx.objectStore('sessionSummaries').clear(),
        tx.objectStore('files').clear(),
        tx.objectStore('tombstones').clear(),
      ])
    },
    tx.done,
  ])
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
