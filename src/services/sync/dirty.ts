/**
 * 本地待推送的会话集合。
 * 单独成模块，避免 store 与 sync 互相引用：store 只负责标记，sync 读取并在推送成功后清空。
 * 同时写入 localStorage，保证关闭页面后才完成的修改在下次打开时仍能推送。
 */
const STORAGE_KEY = 'chat-demo:sync-dirty'

const read = (): string[] => {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

const dirty = new Set<string>(read())

const persist = () => {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...dirty]))
  } catch {
    // 存储已满或被禁用时退化为仅内存标记。
  }
}

export const markDirty = (sessionId: string) => {
  if (!dirty.has(sessionId)) {
    dirty.add(sessionId)
    persist()
  }
}

export const markAllDirty = (sessionIds: Iterable<string>) => {
  let changed = false
  for (const id of sessionIds) {
    if (!dirty.has(id)) {
      dirty.add(id)
      changed = true
    }
  }
  if (changed) {
    persist()
  }
}

export const dirtySnapshot = (): string[] => [...dirty]

export const clearDirty = (sessionIds: Iterable<string>) => {
  let changed = false
  for (const id of sessionIds) {
    if (dirty.delete(id)) {
      changed = true
    }
  }
  if (changed) {
    persist()
  }
}

/** 全局重置后旧会话的待推送记录已无意义。 */
export const clearAllDirty = () => {
  if (dirty.size > 0) {
    dirty.clear()
    persist()
  }
}
