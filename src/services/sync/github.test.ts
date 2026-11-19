import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubClient, GitHubError, type GitHubConfig } from './github.js'

const config: GitHubConfig = {
  owner: 'alice',
  repo: 'chat-data',
  branch: 'main',
  token: 'token',
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

const mockFetch = (handler: (url: string, init?: RequestInit) => Response) => {
  const fn = vi.fn(handler)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHubClient', () => {
  it('分支不存在时返回 null', async () => {
    mockFetch(() => json({ message: 'Not Found' }, 404))
    const client = new GitHubClient(config)
    await expect(client.getHead()).resolves.toBeNull()
  })

  it('401 映射为权限错误', async () => {
    mockFetch(() => json({ message: 'Bad credentials' }, 401))
    const client = new GitHubClient(config)
    await expect(client.getHead()).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    } satisfies Partial<GitHubError>)
  })

  it('403 且额度耗尽时带上恢复时间', async () => {
    mockFetch(() =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
      })
    )
    const client = new GitHubClient(config)
    await expect(client.getHead()).rejects.toMatchObject({
      kind: 'rate-limit',
      resetAt: 1700000000000,
    } satisfies Partial<GitHubError>)
  })

  it('下载并解码 base64 blob', async () => {
    mockFetch(() => json({ content: btoa('hello'), encoding: 'base64' }))
    const client = new GitHubClient(config)
    const blob = await client.getBlob('sha')
    await expect(blob.text()).resolves.toBe('hello')
  })

  it('上传 blob 使用 base64 编码', async () => {
    const fetchMock = mockFetch(() => json({ sha: 'new-sha' }))
    const client = new GitHubClient(config)
    await expect(client.createBlob(new Blob(['hi']))).resolves.toBe('new-sha')
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({ content: btoa('hi'), encoding: 'base64' })
  })

  it('更新 ref 时携带 force 与目标提交', async () => {
    const fetchMock = mockFetch(() => json({}))
    const client = new GitHubClient(config)
    await client.updateRef('commit-sha', true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/alice/chat-data/git/refs/heads/main')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ sha: 'commit-sha', force: true })
  })

  it('读取仓库可见性与默认分支', async () => {
    mockFetch(() => json({ private: true, default_branch: 'main' }))
    const client = new GitHubClient(config)
    await expect(client.getRepo()).resolves.toEqual({ private: true, defaultBranch: 'main' })
  })

  it('仓库根路径不带尾斜杠，避免 CORS 预检 404', async () => {
    const fetchMock = mockFetch(() => json({ private: false, size: 0 }))
    const client = new GitHubClient(config)
    await client.getRepo()
    await client.getRepoSizeKb()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/alice/chat-data',
      'https://api.github.com/repos/alice/chat-data',
    ])
  })

  it('仓库不可见时按未找到处理', async () => {
    mockFetch(() => json({ message: 'Not Found' }, 404))
    const client = new GitHubClient(config)
    await expect(client.getRepo()).rejects.toMatchObject({
      kind: 'not-found',
      status: 404,
    } satisfies Partial<GitHubError>)
  })

  it('从响应头记录 Token 过期时间', async () => {
    mockFetch(() =>
      json({}, 200, { 'github-authentication-token-expiration': '2027-01-01T00:00:00Z' })
    )
    const client = new GitHubClient(config)
    expect(client.getTokenExpiresAt()).toBeNull()
    await client.getRepo()
    expect(client.getTokenExpiresAt()).toBe(Date.parse('2027-01-01T00:00:00Z'))
  })
})
