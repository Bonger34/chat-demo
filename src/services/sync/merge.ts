import type { Message, Session } from '../chat/types.js'

/** 已删除会话的墓碑；永久保留，防止旧设备把会话重新同步回来。 */
export type Tombstone = { id: string; deletedAt: number }

export type MergeStats = {
  /** 本次合并新加入本地的会话数。 */
  sessionsAdded: number
  /** 两端都存在、但内容发生变化的会话数。 */
  sessionsUpdated: number
  /** 从远端新增到本地的消息数。 */
  messagesAdded: number
  /** 远端新增消息在本地已有同父消息，因而形成新分支的次数。 */
  branchesAdded: number
  /** 因墓碑而被删除的本地会话数。 */
  deletedSessions: number
}

export type MergeResult = {
  sessions: Session[]
  tombstones: Tombstone[]
  stats: MergeStats
}

const timestamp = (value?: number) => value ?? 0

const terminalRank = (message: Message): number => {
  if (message.role !== 'assistant') {
    return 0
  }
  switch (message.status) {
    case 'done':
      return 3
    case 'stopped':
      return 2
    case 'error':
      return 1
    default:
      return 0
  }
}

/** 同一 id 防御性取舍：终态优先，其次取内容更多的一份，最后按序列化结果决胜。 */
const pickMessage = (local: Message, remote: Message): Message => {
  const localRank = terminalRank(local)
  const remoteRank = terminalRank(remote)
  if (localRank !== remoteRank) {
    return localRank > remoteRank ? local : remote
  }
  const localSize = local.role === 'assistant' ? local.blocks.length : local.content.length
  const remoteSize = remote.role === 'assistant' ? remote.blocks.length : remote.content.length
  if (localSize !== remoteSize) {
    return localSize > remoteSize ? local : remote
  }
  return JSON.stringify(local) >= JSON.stringify(remote) ? local : remote
}

/**
 * 指针字段（标题、分支选择）按时间戳 LWW。
 * 时间戳相同时比较候选值的字典序，保证交换两端后结果仍一致。
 */
const pickByTime = <T>(
  local: T,
  remote: T,
  localAt: number | undefined,
  remoteAt: number | undefined,
  value: (item: T) => string
): T => {
  const localTime = timestamp(localAt)
  const remoteTime = timestamp(remoteAt)
  if (localTime !== remoteTime) {
    return localTime > remoteTime ? local : remote
  }
  return value(local) >= value(remote) ? local : remote
}

/** 字符串指针冲突时取字典序较小者，保证两端合并结果一致。 */
const pickStableString = (
  local: string | null | undefined,
  remote: string | null | undefined
): string | null | undefined => {
  if (local === remote) {
    return local
  }
  if (local === undefined) {
    return remote
  }
  if (remote === undefined) {
    return local
  }
  if (local === null) {
    return remote
  }
  if (remote === null) {
    return local
  }
  return local < remote ? local : remote
}

const mergeMessage = (local: Message, remote: Message): Message => {
  const chosen = pickMessage(local, remote)
  const pointer = pickByTime(
    local,
    remote,
    local.selectedAt,
    remote.selectedAt,
    (message) => message.selectedChildId ?? ''
  )
  return {
    ...chosen,
    parentId: pickStableString(local.parentId, remote.parentId),
    selectedChildId: pointer.selectedChildId,
    selectedAt: Math.max(timestamp(local.selectedAt), timestamp(remote.selectedAt)) || undefined,
  }
}

const messageOrder = (a: Message, b: Message) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id)

type MessageUnion = { messages: Message[]; remoteAdded: number; branchesAdded: number }

/** 消息按 id 求并集；同 id 合并指针字段，结果按创建时间稳定排序。 */
const unionMessages = (local: Message[], remote: Message[]): MessageUnion => {
  const merged = new Map<string, Message>(local.map((message) => [message.id, message]))
  let remoteAdded = 0
  let branchesAdded = 0
  for (const message of remote) {
    const existing = merged.get(message.id)
    if (!existing) {
      merged.set(message.id, message)
      remoteAdded += 1
      // 本地已有同一父节点的其他消息时，远端消息构成新分支。
      if (local.some((item) => item.parentId === message.parentId)) {
        branchesAdded += 1
      }
      continue
    }
    merged.set(message.id, mergeMessage(existing, message))
  }
  return {
    messages: [...merged.values()].sort(messageOrder),
    remoteAdded,
    branchesAdded,
  }
}

const mergeSession = (local: Session, remote: Session) => {
  const union = unionMessages(local.messages, remote.messages)
  const titleAt = Math.max(timestamp(local.titleAt), timestamp(remote.titleAt))
  const title = pickByTime(
    local.title,
    remote.title,
    local.titleAt,
    remote.titleAt,
    (value) => value
  )
  return {
    session: {
      ...remote,
      ...local,
      title,
      titleAt: titleAt || undefined,
      createdAt: Math.min(local.createdAt, remote.createdAt),
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
      messages: union.messages,
      rootMessageId: pickStableString(local.rootMessageId, remote.rootMessageId),
    } satisfies Session,
    remoteAdded: union.remoteAdded,
    branchesAdded: union.branchesAdded,
  }
}

const mergeTombstones = (tombstones: Tombstone[]): Tombstone[] => {
  const merged = new Map<string, number>()
  for (const tombstone of tombstones) {
    const previous = merged.get(tombstone.id)
    merged.set(
      tombstone.id,
      previous === undefined ? tombstone.deletedAt : Math.min(previous, tombstone.deletedAt)
    )
  }
  return [...merged.entries()]
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 合并本地与远端快照。
 * 输入不改动；会话按 id 并集、消息按 id 并集，墓碑优先于内容。
 * `tombstones` 为两端墓碑的并集；`_writer` 保留为设备标识参数（时间戳相同时结果只依赖数据本身）。
 * 合并结果与调用顺序无关，重复合并幂等。
 */
export function mergeSessions(
  local: Session[],
  remote: Session[],
  tombstones: Tombstone[],
  writer: string
): MergeResult {
  // writer 保留在接口中：时间戳相同时按候选值字典序决胜，结果与设备、合并顺序无关。
  void writer
  const tombstoneList = mergeTombstones(tombstones)
  const deleted = new Set(tombstoneList.map((tombstone) => tombstone.id))
  const localById = new Map(local.map((session) => [session.id, session]))
  const remoteById = new Map(remote.map((session) => [session.id, session]))
  const ids = new Set([...localById.keys(), ...remoteById.keys()])
  const stats: MergeStats = {
    sessionsAdded: 0,
    sessionsUpdated: 0,
    messagesAdded: 0,
    branchesAdded: 0,
    deletedSessions: 0,
  }
  const sessions: Session[] = []
  for (const id of ids) {
    const localSession = localById.get(id)
    const remoteSession = remoteById.get(id)
    if (deleted.has(id)) {
      if (localSession) {
        stats.deletedSessions += 1
      }
      continue
    }
    if (localSession && remoteSession) {
      const merged = mergeSession(localSession, remoteSession)
      sessions.push(merged.session)
      stats.messagesAdded += merged.remoteAdded
      stats.branchesAdded += merged.branchesAdded
      if (JSON.stringify(merged.session) !== JSON.stringify(localSession)) {
        stats.sessionsUpdated += 1
      }
      continue
    }
    if (remoteSession) {
      sessions.push(remoteSession)
      stats.sessionsAdded += 1
      continue
    }
    if (localSession) {
      sessions.push(localSession)
    }
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return { sessions, tombstones: tombstoneList, stats }
}
