import type { Session } from '../chat/types.js'

/** 快照格式不符合预期；同步层捕获后提示升级或跳过损坏文件。 */
export class SyncFormatError extends Error {
  override name = 'SyncFormatError'
}

export type Manifest = {
  format_version: 1
  epoch: string
  reset_at: string
  written_at: string
  writer: string
}

export type SessionFile = {
  session: Session
  /** 附件本地 id → 内容 SHA-256；本地没有原件的附件不出现在这里。 */
  files: Record<string, string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const assertSession = (value: unknown): Session => {
  if (!isRecord(value)) {
    throw new SyncFormatError('session must be an object')
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new SyncFormatError('session.id is required')
  }
  if (typeof value.title !== 'string') {
    throw new SyncFormatError('session.title must be a string')
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new SyncFormatError('session timestamps are required')
  }
  if (!Array.isArray(value.messages)) {
    throw new SyncFormatError('session.messages must be an array')
  }
  for (const message of value.messages) {
    if (!isRecord(message) || typeof message.id !== 'string') {
      throw new SyncFormatError('message.id is required')
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new SyncFormatError('message.role is invalid')
    }
    if (!isTimestamp(message.createdAt)) {
      throw new SyncFormatError('message.createdAt is required')
    }
    if (message.role === 'user' && typeof message.content !== 'string') {
      throw new SyncFormatError('user message content must be a string')
    }
    if (message.role === 'assistant' && !Array.isArray(message.blocks)) {
      throw new SyncFormatError('assistant message blocks must be an array')
    }
  }
  return value as Session
}

export const toSessionFile = (session: Session, fileShas: Record<string, string>): string =>
  JSON.stringify({ session, files: fileShas })

export const fromSessionFile = (text: string): SessionFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SyncFormatError('session file is not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw new SyncFormatError('session file must be an object')
  }
  if (!isRecord(parsed.files)) {
    throw new SyncFormatError('session file files must be an object')
  }
  const files: Record<string, string> = {}
  for (const [id, sha] of Object.entries(parsed.files)) {
    if (typeof sha !== 'string') {
      throw new SyncFormatError('file sha must be a string')
    }
    files[id] = sha
  }
  return { session: assertSession(parsed.session), files }
}

export const toManifest = (value: Manifest): string => JSON.stringify(value)

export const fromManifest = (text: string): Manifest => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SyncFormatError('manifest is not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw new SyncFormatError('manifest must be an object')
  }
  if (parsed.format_version !== 1) {
    throw new SyncFormatError('unsupported manifest format_version')
  }
  if (typeof parsed.epoch !== 'string' || !parsed.epoch) {
    throw new SyncFormatError('manifest.epoch is required')
  }
  if (typeof parsed.writer !== 'string' || !parsed.writer) {
    throw new SyncFormatError('manifest.writer is required')
  }
  if (typeof parsed.reset_at !== 'string' || Number.isNaN(Date.parse(parsed.reset_at))) {
    throw new SyncFormatError('manifest.reset_at is invalid')
  }
  if (typeof parsed.written_at !== 'string' || Number.isNaN(Date.parse(parsed.written_at))) {
    throw new SyncFormatError('manifest.written_at is invalid')
  }
  return parsed as Manifest
}

/** 计算 Blob 的 SHA-256，作为附件在仓库中的内容寻址路径。 */
export const sha256Hex = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
