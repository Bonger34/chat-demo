export type RepoRef = {
  owner: string
  repo: string
}

const segmentPattern = /^[A-Za-z0-9_.-]+$/

const clean = (owner: string, repo: string): RepoRef | null => {
  const name = repo.replace(/\.git$/i, '')
  if (!owner || !name || !segmentPattern.test(owner) || !segmentPattern.test(name)) {
    return null
  }
  return { owner, repo: name }
}

/** 解析 `owner/repo`、GitHub 仓库 URL 和带 `.git` 的克隆地址；其他域名返回 null。 */
export const parseRepoInput = (value: string): RepoRef | null => {
  const text = value.trim().replace(/\/+$/, '')
  if (!text) {
    return null
  }
  if (!text.includes('://')) {
    const parts = text.split('/')
    return parts.length === 2 ? clean(parts[0], parts[1]) : null
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  if (url.hostname.toLowerCase() !== 'github.com') {
    return null
  }
  const [owner, repo, ...rest] = url.pathname.split('/').filter(Boolean)
  return owner && repo && rest.length === 0 ? clean(owner, repo) : null
}
