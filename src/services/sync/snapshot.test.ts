import { describe, expect, it } from 'vitest'
import type { Session } from '../chat/types.js'
import {
  fromManifest,
  fromSessionFile,
  sha256Hex,
  SyncFormatError,
  toManifest,
  toSessionFile,
  type Manifest,
} from './snapshot.js'

const session: Session = {
  id: 's1',
  title: '会话',
  createdAt: 1,
  updatedAt: 2,
  titleAt: 2,
  rootMessageId: 'u1',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: '你好',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'a1',
      selectedAt: 2,
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: 2,
      model: null,
      prefix: true,
      status: 'done',
      blocks: [],
    },
  ],
}

const manifest: Manifest = {
  format_version: 1,
  epoch: 'epoch-1',
  reset_at: '2026-11-17T10:00:00.000Z',
  written_at: '2026-11-17T10:32:11.000Z',
  writer: 'device-a',
}

describe('snapshot', () => {
  it('会话文件往返保留消息、分支和附件索引', () => {
    const text = toSessionFile(session, { 'file-1': 'sha-1' })
    const parsed = fromSessionFile(text)

    expect(parsed.session).toEqual(session)
    expect(parsed.files).toEqual({ 'file-1': 'sha-1' })
  })

  it('拒绝非法 JSON 与缺失字段的会话文件', () => {
    expect(() => fromSessionFile('not json')).toThrow(SyncFormatError)
    expect(() => fromSessionFile('{}')).toThrow(SyncFormatError)
    expect(() => fromSessionFile(JSON.stringify({ session: { id: 's1' }, files: {} }))).toThrow(
      SyncFormatError
    )
  })

  it('manifest 往返并校验版本', () => {
    expect(fromManifest(toManifest(manifest))).toEqual(manifest)
    expect(() => fromManifest(JSON.stringify({ ...manifest, format_version: 2 }))).toThrow(
      SyncFormatError
    )
    expect(() => fromManifest(JSON.stringify({ ...manifest, reset_at: 'not a date' }))).toThrow(
      SyncFormatError
    )
  })

  it('按内容计算 SHA-256', async () => {
    const digest = await sha256Hex(new Blob(['hello']))
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})
