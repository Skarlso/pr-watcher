export type Pr = {
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
