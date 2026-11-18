/** The newest comment, review or head commit of a PR: what a poll compares. */
export type Mark = {
  id: string
  at: number
  by: string | null
  isBot: boolean
  state?: string
}

export type Pr = {
  id: string
  url: string
  repo: string
  number: number
  title: string
  author: string
  isDraft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null
  updatedAt: number
  latest: { comment: Mark | null; review: Mark | null; push: Mark | null }
}

export type Section = { prs: Pr[]; total: number }

export type Board = {
  mine: Section
  reviews: Section
  watched: Pr[]
  missing: string[]
  ignored: number
  fetchedAt: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-watcher': { board: Shaped<Board> }
  }
}
