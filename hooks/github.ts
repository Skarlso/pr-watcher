import type { Board, Pr, Section } from '../types'

export type Ref = { owner: string; repo: string; number: number }

const REF =
  /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:#|\/pull\/)(\d+)(?:[/?#].*)?$/

export const parseRef = (text: string): Ref | undefined => {
  const [, owner, repo, number] = REF.exec(text.trim()) ?? []
  if (!owner || !repo || !number) return undefined

  return { owner, repo, number: Number(number) }
}

export const refKey = (ref: Ref) => `${ref.owner}/${ref.repo}#${ref.number}`

export const prKey = (pr: Pr) => `${pr.repo}#${pr.number}`.toLowerCase()

const REPO = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/?$/

/** What an ignore names, lowercased: one PR (`owner/repo#123`) or a whole repo. */
export const parseTarget = (text: string): string | undefined => {
  const ref = parseRef(text)
  const key = ref ? refKey(ref) : REPO.exec(text.trim())?.[1]

  return key?.toLowerCase()
}

const FIELDS = `fragment F on PullRequest {
  number title url isDraft state reviewDecision updatedAt
  repository { nameWithOwner }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

const search = (alias: string, filter: string) =>
  `${alias}: search(query: "is:pr is:open ${filter} sort:updated-desc", type: ISSUE, first: 30) { issueCount nodes { ...F } }`

// Refs are inlined, not passed as variables: parseRef's pattern is what keeps them safe.
export const buildQuery = (refs: readonly Ref[]) =>
  [
    FIELDS,
    'query {',
    search('mine', 'author:@me'),
    search('reviews', 'review-requested:@me'),
    ...refs.map(
      (ref, i) =>
        `w${i}: repository(owner: "${ref.owner}", name: "${ref.repo}") { pullRequest(number: ${ref.number}) { ...F } }`,
    ),
    '}',
  ].join('\n')

type RawPr = {
  number?: number
  title?: string
  url?: string
  isDraft?: boolean
  state?: Pr['state']
  reviewDecision?: Pr['review']
  updatedAt?: string
  repository?: { nameWithOwner?: string }
  author?: { login?: string } | null
  commits?: {
    nodes?: { commit?: { statusCheckRollup?: { state?: Pr['checks'] } | null } }[]
  }
}

type RawSearch = { issueCount?: number; nodes?: (RawPr | null)[] }

type Reply = {
  data?: Record<string, RawSearch | { pullRequest?: RawPr | null } | null>
  errors?: { message?: string }[]
}

const toPr = (raw: RawPr | null | undefined): Pr | undefined => {
  if (!raw?.url || raw.number === undefined) return undefined

  return {
    url: raw.url,
    repo: raw.repository?.nameWithOwner ?? '',
    number: raw.number,
    title: raw.title ?? '',
    author: raw.author?.login ?? 'ghost',
    isDraft: raw.isDraft ?? false,
    state: raw.state ?? 'OPEN',
    review: raw.reviewDecision ?? null,
    checks: raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    updatedAt: Date.parse(raw.updatedAt ?? '') || 0,
  }
}

const toSection = (raw: unknown): Section => {
  const { issueCount, nodes = [] } = (raw ?? {}) as RawSearch
  const prs = nodes.flatMap(node => toPr(node) ?? [])

  return { prs, total: issueCount ?? prs.length }
}

export type Lists = Pick<Board, 'mine' | 'reviews' | 'watched' | 'missing'>

export const hide = <T extends Lists>(lists: T, ignored: readonly string[]): T => {
  const names = new Set(ignored)
  const isKept = (pr: Pr) =>
    !names.has(prKey(pr)) && !names.has(pr.repo.toLowerCase())
  // The total is GitHub's count, so it drops by what was hidden here.
  const trim = (section: Section): Section => {
    const prs = section.prs.filter(isKept)

    return { prs, total: section.total - (section.prs.length - prs.length) }
  }

  return {
    ...lists,
    mine: trim(lists.mine),
    reviews: trim(lists.reviews),
    watched: lists.watched.filter(isKept),
  }
}

/** Reads gh's reply; a string is the reason there is no board to show. */
export const parseReply = (stdout: string, refs: readonly Ref[]): Lists | string => {
  let reply: Reply
  try {
    reply = JSON.parse(stdout) as Reply
  } catch {
    return 'gh answered something that is not JSON'
  }
  const { data, errors } = reply
  // A watched PR that is gone answers an error too, beside data that is whole.
  if (!data?.mine) return errors?.[0]?.message ?? 'gh answered no data'

  const mine = toSection(data.mine)
  const reviews = toSection(data.reviews)
  const listed = new Set([...mine.prs, ...reviews.prs].map(pr => pr.url))
  const watched: Pr[] = []
  const missing: string[] = []
  refs.forEach((ref, i) => {
    const found = data[`w${i}`] as { pullRequest?: RawPr | null } | null
    const pr = toPr(found?.pullRequest)
    if (!pr) missing.push(refKey(ref))
    else if (!listed.has(pr.url)) watched.push(pr)
  })

  return { mine, reviews, watched, missing }
}
