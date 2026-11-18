import type { Mark, Pr } from '../types'
import type { Ending, Lists } from './github'

const REVIEWED: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes on',
  COMMENTED: 'reviewed',
}

const CI: Partial<Record<NonNullable<Pr['checks']>, string>> = {
  SUCCESS: 'passed',
  FAILURE: 'failed',
  ERROR: 'failed',
}

const name = (pr: Pr) =>
  `${pr.repo.split('/')[1] ?? pr.repo}#${pr.number} · ${pr.title}`

const who = (by: string | null) => (by ? `@${by}` : 'Someone')

const all = (lists: Lists) =>
  new Map(
    [...lists.mine.prs, ...lists.reviews.prs, ...lists.watched].map(pr => [pr.url, pr]),
  )

// `at` guards a deleted comment: the one before it surfaces with an older time.
const isNews = (before: Mark | null, after: Mark | null, me: string): after is Mark =>
  after !== null &&
  after.id !== before?.id &&
  after.at >= (before?.at ?? 0) &&
  !after.isBot &&
  after.by?.toLowerCase() !== me

/** What others did between two polls, one line each; a PR seen for the first time says nothing. */
export const changes = (before: Lists, after: Lists, viewer: string): string[] => {
  const me = viewer.toLowerCase()
  const seen = all(before)
  const events: string[] = []
  const look = (pr: Pr, hasChecks: boolean) => {
    const old = seen.get(pr.url)
    if (!old) return
    const { comment, review, push } = pr.latest
    if (isNews(old.latest.comment, comment, me)) {
      events.push(`${who(comment.by)} commented on ${name(pr)}`)
    }
    const verb = REVIEWED[review?.state ?? '']
    if (verb && isNews(old.latest.review, review, me)) {
      events.push(`${who(review.by)} ${verb} ${name(pr)}`)
    }
    // A commit GitHub ties to no account, on my own PR, is most likely mine.
    const isMine = push?.by === null && pr.author.toLowerCase() === me
    if (isNews(old.latest.push, push, me) && !isMine) {
      events.push(`${who(push.by)} pushed to ${name(pr)}`)
    }
    const result = pr.checks ? CI[pr.checks] : undefined
    if (hasChecks && result && result !== (old.checks ? CI[old.checks] : undefined)) {
      events.push(`CI ${result} on ${name(pr)}`)
    }
  }
  after.mine.prs.forEach(pr => look(pr, true))
  after.reviews.prs.forEach(pr => look(pr, false))
  after.watched.forEach(pr => look(pr, true))

  return events
}

/** The node ids of PRs that left a list or stopped being open: what a lookup asks about. */
export const departed = (before: Lists, after: Lists): string[] => {
  const now = all(after)
  const gone = [...before.mine.prs, ...before.reviews.prs].filter(
    pr => !now.has(pr.url),
  )
  const ended = before.watched.filter(pr => {
    const next = now.get(pr.url)

    return pr.state === 'OPEN' && next !== undefined && next.state !== 'OPEN'
  })

  return [...gone, ...ended].flatMap(pr => pr.id || []).slice(0, 20)
}

export const endings = (list: readonly Ending[], viewer: string): string[] =>
  list
    .filter(one => one.by?.toLowerCase() !== viewer.toLowerCase())
    .map(
      one =>
        `${who(one.by)} ${one.state === 'MERGED' ? 'merged' : 'closed'} ${name(one.pr)}`,
    )
