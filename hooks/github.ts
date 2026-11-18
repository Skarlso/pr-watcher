import type { Board, Mark, Pr, Section } from '../types'

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
  id number title url isDraft state reviewDecision updatedAt
  repository { nameWithOwner }
  author { login }
  comments(last: 1) { nodes { id createdAt author { __typename login } } }
  reviews(last: 1) { nodes { id state submittedAt author { __typename login } } }
  commits(last: 1) { nodes { commit { oid committedDate author { user { login } } statusCheckRollup { state } } } }
}`

const search = (alias: string, filter: string) =>
  `${alias}: search(query: "is:pr is:open ${filter} sort:updated-desc", type: ISSUE, first: 30) { issueCount nodes { ...F } }`

// Two requests, run side by side: GitHub runs a query's searches one after the
// other, and both in one request come close to its ten second limit (a 502).
// Refs are inlined, not passed as variables: parseRef's pattern keeps them safe.
export const buildQueries = (refs: readonly Ref[]) => [
  [FIELDS, 'query {', 'viewer { login }', search('mine', 'author:@me'), '}'].join('\n'),
  [
    FIELDS,
    'query {',
    search('reviews', 'review-requested:@me'),
    ...refs.map(
      (ref, i) =>
        `w${i}: repository(owner: "${ref.owner}", name: "${ref.repo}") { pullRequest(number: ${ref.number}) { ...F } }`,
    ),
    '}',
  ].join('\n'),
]

type RawActor = { __typename?: string; login?: string } | null

type RawPr = {
  id?: string
  number?: number
  title?: string
  url?: string
  isDraft?: boolean
  state?: Pr['state']
  reviewDecision?: Pr['review']
  updatedAt?: string
  repository?: { nameWithOwner?: string }
  author?: { login?: string } | null
  comments?: { nodes?: { id?: string; createdAt?: string; author?: RawActor }[] }
  reviews?: {
    nodes?: { id?: string; state?: string; submittedAt?: string | null; author?: RawActor }[]
  }
  commits?: {
    nodes?: {
      commit?: {
        oid?: string
        committedDate?: string
        author?: { user?: { login?: string } | null } | null
        statusCheckRollup?: { state?: Pr['checks'] } | null
      }
    }[]
  }
}

const toMark = (
  id: string | undefined,
  at: string | null | undefined,
  actor: RawActor | undefined,
  state?: string,
): Mark | null =>
  id
    ? {
        id,
        at: Date.parse(at ?? '') || 0,
        by: actor?.login ?? null,
        isBot: actor?.__typename === 'Bot',
        ...(state ? { state } : {}),
      }
    : null

type RawSearch = { issueCount?: number; nodes?: (RawPr | null)[] }

type Data = Record<string, RawSearch | { pullRequest?: RawPr | null } | null> & {
  viewer?: { login?: string }
}

type Reply = { data?: Data; errors?: { message?: string }[] }

const toPr = (raw: RawPr | null | undefined): Pr | undefined => {
  if (!raw?.url || raw.number === undefined) return undefined
  const comment = raw.comments?.nodes?.[0]
  const review = raw.reviews?.nodes?.[0]
  const head = raw.commits?.nodes?.[0]?.commit

  return {
    id: raw.id ?? '',
    url: raw.url,
    repo: raw.repository?.nameWithOwner ?? '',
    number: raw.number,
    title: raw.title ?? '',
    author: raw.author?.login ?? 'ghost',
    isDraft: raw.isDraft ?? false,
    state: raw.state ?? 'OPEN',
    review: raw.reviewDecision ?? null,
    checks: head?.statusCheckRollup?.state ?? null,
    updatedAt: Date.parse(raw.updatedAt ?? '') || 0,
    latest: {
      comment: toMark(comment?.id, comment?.createdAt, comment?.author),
      review: toMark(review?.id, review?.submittedAt, review?.author, review?.state),
      push: toMark(head?.oid, head?.committedDate, head?.author?.user),
    },
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

/** Reads gh's replies to buildQueries; a string is the reason there is no board to show. */
export const parseReply = (
  stdouts: readonly string[],
  refs: readonly Ref[],
): (Lists & { viewer: string }) | string => {
  let replies: Reply[]
  try {
    replies = stdouts.map(stdout => JSON.parse(stdout) as Reply)
  } catch {
    return 'gh answered something that is not JSON'
  }
  const data: Data = Object.assign({}, ...replies.map(reply => reply.data))
  const errors = replies.flatMap(reply => reply.errors ?? [])
  // A watched PR that is gone answers an error too, beside data that is whole.
  if (!data.mine || !data.reviews) {
    return errors[0]?.message ?? 'gh answered no data'
  }

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

  return { mine, reviews, watched, missing, viewer: data.viewer?.login ?? '' }
}

export type Ending = { pr: Pr; state: Pr['state']; by: string | null }

export const buildLookup = (ids: readonly string[]) =>
  `query { nodes(ids: ${JSON.stringify(ids)}) { ...F ... on PullRequest {
  mergedBy { login }
  timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
} } }
${FIELDS}`

type RawEnding = RawPr & {
  mergedBy?: { login?: string } | null
  timelineItems?: { nodes?: ({ actor?: { login?: string } | null } | null)[] }
}

/** How the PRs a lookup asked about ended; one still open is left out. */
export const parseLookup = (stdout: string): Ending[] => {
  let nodes: (RawEnding | null)[]
  try {
    nodes = (JSON.parse(stdout) as { data?: { nodes?: (RawEnding | null)[] } }).data?.nodes ?? []
  } catch {
    return []
  }

  return nodes.flatMap(raw => {
    const pr = toPr(raw)
    if (!pr || pr.state === 'OPEN') return []
    const closer = raw?.timelineItems?.nodes?.[0]?.actor?.login
    const by = pr.state === 'MERGED' ? raw?.mergedBy?.login : closer

    return { pr, state: pr.state, by: by ?? null }
  })
}
