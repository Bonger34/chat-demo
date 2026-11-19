import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Message, Session, UserMessage } from '../chat/types.js'
import { mergeSessions, type Tombstone } from './merge.js'

const user = (
  id: string,
  createdAt: number,
  parentId: string | null = null,
  extra: Partial<UserMessage> = {}
): UserMessage => ({
  id,
  role: 'user',
  content: id,
  files: [],
  createdAt,
  parentId,
  ...extra,
})

const assistant = (
  id: string,
  createdAt: number,
  parentId: string | null = null,
  extra: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [],
  parentId,
  ...extra,
})

const session = (id: string, messages: Message[], extra: Partial<Session> = {}): Session => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  messages,
  rootMessageId: messages[0]?.id ?? null,
  ...extra,
})

const ids = (messages: Message[]) => messages.map((message) => message.id)

describe('mergeSessions', () => {
  it('合并两端各自新增的消息，不丢消息', () => {
    const local = session('s1', [user('u1', 1), assistant('a1', 2, 'u1')])
    const remote = session('s1', [
      user('u1', 1),
      assistant('a1', 2, 'u1'),
      user('u2', 3, 'a1'),
      assistant('a2', 4, 'u2'),
    ])

    const result = mergeSessions([local], [remote], [], 'device-a')

    expect(ids(result.sessions[0].messages)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(result.stats.messagesAdded).toBe(2)
  })

  it('墓碑优先，删除的会话不会被旧数据复活', () => {
    const tombstones: Tombstone[] = [{ id: 's1', deletedAt: 10 }]
    const result = mergeSessions(
      [session('s1', [user('u1', 1)])],
      [session('s1', [user('u2', 2)])],
      tombstones,
      'device-a'
    )

    expect(result.sessions).toEqual([])
    expect(result.tombstones).toEqual([{ id: 's1', deletedAt: 10 }])
    expect(result.stats.deletedSessions).toBe(1)
  })

  it('标题按 titleAt 决胜，时间较新的一端覆盖', () => {
    const local = session('s1', [], { title: '旧标题', titleAt: 1 })
    const remote = session('s1', [], { title: '新标题', titleAt: 2 })

    const result = mergeSessions([local], [remote], [], 'device-a')

    expect(result.sessions[0].title).toBe('新标题')
    expect(result.sessions[0].titleAt).toBe(2)
  })

  it('分支选择按 selectedAt 决胜，输掉的分支仍然保留在消息树里', () => {
    const local = session('s1', [
      user('u1', 1, null, { selectedChildId: 'a1', selectedAt: 1 }),
      assistant('a1', 2, 'u1'),
      assistant('a2', 3, 'u1'),
    ])
    const remote = session('s1', [
      user('u1', 1, null, { selectedChildId: 'a2', selectedAt: 2 }),
      assistant('a1', 2, 'u1'),
      assistant('a2', 3, 'u1'),
    ])

    const result = mergeSessions([local], [remote], [], 'device-a')
    const root = result.sessions[0].messages.find((message) => message.id === 'u1')

    expect(root?.selectedChildId).toBe('a2')
    expect(ids(result.sessions[0].messages)).toEqual(['u1', 'a1', 'a2'])
  })

  it('幂等：合并结果再与同一远端合并不变', () => {
    const local = session('s1', [user('u1', 1), assistant('a1', 2, 'u1')])
    const remote = session('s1', [user('u1', 1), user('u2', 3)])

    const once = mergeSessions([local], [remote], [], 'device-a')
    const twice = mergeSessions(once.sessions, [remote], [], 'device-a')

    expect(twice.sessions).toEqual(once.sessions)
    expect(twice.tombstones).toEqual(once.tombstones)
  })

  it('可交换：两端各自合并得到相同结果', () => {
    const local = session('s1', [
      user('u1', 1, null, { selectedChildId: 'a1' }),
      assistant('a1', 2, 'u1'),
    ])
    const remote = session('s1', [
      user('u1', 1, null, { selectedChildId: 'a2' }),
      assistant('a2', 3, 'u1'),
    ])

    const a = mergeSessions([local], [remote], [], 'device-a')
    const b = mergeSessions([remote], [local], [], 'device-b')

    expect(a.sessions).toEqual(b.sessions)
    expect(a.tombstones).toEqual(b.tombstones)
  })

  it('时间戳相同时按候选值字典序决胜，与合并顺序和设备无关', () => {
    const local = session('s1', [], { title: 'Beta', titleAt: 5 })
    const remote = session('s1', [], { title: 'Alpha', titleAt: 5 })

    const a = mergeSessions([local], [remote], [], 'device-a')
    const b = mergeSessions([remote], [local], [], 'device-b')

    expect(a.sessions[0].title).toBe('Beta')
    expect(b.sessions[0].title).toBe('Beta')
  })

  it('统计远端新增的分支数', () => {
    const local = session('s1', [user('u1', 1), assistant('a1', 2, 'u1')])
    const remote = session('s1', [user('u1', 1), assistant('a2', 3, 'u1')])

    const result = mergeSessions([local], [remote], [], 'device-a')

    expect(result.stats.branchesAdded).toBe(1)
  })
})
