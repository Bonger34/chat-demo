/** 仓库中的文件或目录条目。 */
export type TreeEntry = {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

/** 创建树时的单条变更；sha 为 null 表示删除该路径。 */
export type TreeEntryInput = {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string | null
}

export type GitHubConfig = {
  owner: string
  repo: string
  branch: string
  token: string
}

export type GitHubErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'not-found'
  | 'network'
  | 'server'
  | 'protocol'

export class GitHubError extends Error {
  override name = 'GitHubError'
  readonly kind: GitHubErrorKind
  readonly status: number | undefined
  /** 限流解除时间（毫秒时间戳） */
  readonly resetAt: number | undefined

  constructor(kind: GitHubErrorKind, message: string, status?: number, resetAt?: number) {
    super(message)
    this.kind = kind
    this.status = status
    this.resetAt = resetAt
  }
}

const API = 'https://api.github.com'

/** 分块编码，避免大文件展开成参数时超出调用栈。 */
const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

const fromBase64 = (content: string): Blob => {
  const binary = atob(content.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new Blob([bytes])
}

/** 只负责 GitHub HTTP 细节，不做任何业务判断。 */
export class GitHubClient {
  private readonly owner: string
  private readonly repo: string
  private readonly branch: string
  private readonly token: string
  /** 细粒度 Token 的过期时间，来自响应头；classic Token 没有该头。 */
  private tokenExpiresAt: number | null = null

  constructor({ owner, repo, branch, token }: GitHubConfig) {
    this.owner = owner
    this.repo = repo
    this.branch = branch
    this.token = token
  }

  private get base() {
    return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`
  }

  private get branchPath() {
    return encodeURIComponent(this.branch)
  }

  private async error(response: Response): Promise<GitHubError> {
    let message = response.statusText
    try {
      const body = (await response.json()) as { message?: unknown }
      if (typeof body.message === 'string') {
        message = body.message
      }
    } catch {
      // 非 JSON 错误体沿用状态文案。
    }
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined
    if (response.status === 401) {
      return new GitHubError('auth', message, response.status)
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      return new GitHubError('rate-limit', message, response.status, resetAt)
    }
    if (response.status === 403) {
      return new GitHubError('auth', message, response.status)
    }
    if (response.status === 404) {
      return new GitHubError('not-found', message, response.status)
    }
    if (response.status >= 500) {
      return new GitHubError('server', message, response.status)
    }
    return new GitHubError('protocol', message, response.status)
  }

  /** allow404 用于区分「分支还不存在」与真正的错误。 */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    allow404 = false
  ): Promise<T | null> {
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      })
    } catch (error) {
      throw new GitHubError('network', error instanceof Error ? error.message : String(error))
    }
    if (response.status === 404 && allow404) {
      return null
    }
    if (!response.ok) {
      throw await this.error(response)
    }
    // 每个响应都可能带过期时间；只在首次拿到有效值时记录。
    if (this.tokenExpiresAt === null) {
      const expires = Date.parse(response.headers.get('github-authentication-token-expiration') ?? '')
      if (Number.isFinite(expires)) {
        this.tokenExpiresAt = expires
      }
    }
    return (await response.json()) as T
  }

  /** 已观察到的 Token 过期时间（毫秒时间戳）；未知时为 null。 */
  getTokenExpiresAt(): number | null {
    return this.tokenExpiresAt
  }

  /** 仓库基本信息；用于配置校验与公开仓库提示。 */
  async getRepo(): Promise<{ private: boolean; defaultBranch: string }> {
    // 路径不能以 / 结尾：带尾斜杠时 GitHub 的 CORS 预检返回 404，浏览器会误报网络错误。
    const data = await this.request<{ private?: boolean; default_branch?: string }>('')
    return { private: data?.private === true, defaultBranch: data?.default_branch ?? '' }
  }

  /** 分支 head；分支不存在（404）或仓库为空（409）时返回 null。 */
  async getHead(): Promise<string | null> {
    try {
      const data = await this.request<{ object: { sha: string } }>(
        `/git/ref/heads/${this.branchPath}`,
        {},
        true
      )
      return data?.object.sha ?? null
    } catch (error) {
      // 空仓库没有提交，GitHub 对 ref 查询返回 409 而不是 404。
      if (error instanceof GitHubError && error.status === 409) {
        return null
      }
      throw error
    }
  }

  /** 提交对应的树与父提交；用于在 head 之上创建新提交。 */
  async getCommit(sha: string): Promise<{ treeSha: string; parents: string[] }> {
    const data = await this.request<{
      tree: { sha: string }
      parents: { sha: string }[]
    }>(`/git/commits/${sha}`)
    if (!data) {
      throw new GitHubError('protocol', 'missing commit response')
    }
    return { treeSha: data.tree.sha, parents: data.parents.map((parent) => parent.sha) }
  }

  async getTree(treeSha: string): Promise<TreeEntry[]> {
    const data = await this.request<{ tree: TreeEntry[] }>(`/git/trees/${treeSha}?recursive=1`)
    return data?.tree ?? []
  }

  /** 按 blob sha 下载原件；会话 JSON 也通过它读取。 */
  async getBlob(sha: string): Promise<Blob> {
    const data = await this.request<{ content: string; encoding: string }>(`/git/blobs/${sha}`)
    if (!data || data.encoding !== 'base64') {
      throw new GitHubError('protocol', 'unsupported blob encoding')
    }
    return fromBase64(data.content)
  }

  /** 仓库体积（KB），用于判断是否跳过附件。 */
  async getRepoSizeKb(): Promise<number> {
    const data = await this.request<{ size?: number }>('')
    return data?.size ?? 0
  }

  async createBlob(blob: Blob): Promise<string> {
    const data = await this.request<{ sha: string }>('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({
        content: toBase64(await blob.arrayBuffer()),
        encoding: 'base64',
      }),
    })
    if (!data) {
      throw new GitHubError('protocol', 'missing blob response')
    }
    return data.sha
  }

  async createTree(baseTree: string | null, entries: TreeEntryInput[]): Promise<string> {
    const data = await this.request<{ sha: string }>('/git/trees', {
      method: 'POST',
      body: JSON.stringify({
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: entries,
      }),
    })
    if (!data) {
      throw new GitHubError('protocol', 'missing tree response')
    }
    return data.sha
  }

  async createCommit(treeSha: string, parents: string[], message: string): Promise<string> {
    const data = await this.request<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents }),
    })
    if (!data) {
      throw new GitHubError('protocol', 'missing commit response')
    }
    return data.sha
  }

  async updateRef(commitSha: string, force: boolean): Promise<void> {
    await this.request(`/git/refs/heads/${this.branchPath}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commitSha, force }),
    })
  }

  async createRef(commitSha: string): Promise<void> {
    await this.request('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${this.branch}`, sha: commitSha }),
    })
  }
}
