import { describe, expect, it } from 'vitest'
import { parseRepoInput } from './repoInput.js'

describe('parseRepoInput', () => {
  it('解析 owner/repo', () => {
    expect(parseRepoInput('alice/chat-data')).toEqual({ owner: 'alice', repo: 'chat-data' })
    expect(parseRepoInput('  alice/chat-data/  ')).toEqual({
      owner: 'alice',
      repo: 'chat-data',
    })
  })

  it('解析仓库 URL 与 .git 后缀', () => {
    expect(parseRepoInput('https://github.com/alice/chat-data')).toEqual({
      owner: 'alice',
      repo: 'chat-data',
    })
    expect(parseRepoInput('https://github.com/alice/chat-data.git')).toEqual({
      owner: 'alice',
      repo: 'chat-data',
    })
    expect(parseRepoInput('https://github.com/alice/chat-data?tab=readme')).toEqual({
      owner: 'alice',
      repo: 'chat-data',
    })
  })

  it('拒绝非 GitHub 域名与不完整路径', () => {
    expect(parseRepoInput('https://gitlab.com/alice/chat-data')).toBeNull()
    expect(parseRepoInput('https://github.com/alice')).toBeNull()
    expect(parseRepoInput('https://github.com/alice/chat-data/tree/main')).toBeNull()
    expect(parseRepoInput('alice')).toBeNull()
    expect(parseRepoInput('')).toBeNull()
  })

  it('拒绝非法字符', () => {
    expect(parseRepoInput('alice/chat data')).toBeNull()
    expect(parseRepoInput('alice/chat%20data')).toBeNull()
  })
})
