import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Pr } from '../types'
import { changes, departed, endings } from './events'
import {
  buildLookup,
  buildQueries,
  hide,
  parseLookup,
  parseRef,
  parseReply,
  parseTarget,
  prKey,
  refKey,
} from './github'
import type { Ref } from './github'

const PANE = 'pr-watcher'
const TITLE = 'Pull requests'
const WATCHED = 'watched'
const IGNORED = 'ignored'
const USAGE = [
  'Usage: /prs [refresh]',
  '       /prs add|remove <owner/repo#123 or PR URL>',
  '       /prs ignore|unignore <owner/repo#123, PR URL or owner/repo>',
  '       /prs ignored',
].join('\n')

const EMPTY: Board = {
  mine: { prs: [], total: 0 },
  reviews: { prs: [], total: 0 },
  watched: [],
  missing: [],
  ignored: 0,
  fetchedAt: null,
  error: null,
}
// Change the tag when Board's fields change: a stored board outlives a reload.
const board = atom({ plugin: 'pr-watcher', key: 'board' } as const, EMPTY, {
  shape: 'board-3',
})

const CHECKS = {
  SUCCESS: ['✓', 'success'],
  FAILURE: ['✗', 'error'],
  ERROR: ['✗', 'error'],
  PENDING: ['●', 'warning'],
  EXPECTED: ['●', 'warning'],
} as const

const REVIEW = {
  APPROVED: ['approved', 'success'],
  CHANGES_REQUESTED: ['changes requested', 'error'],
  REVIEW_REQUIRED: ['review required', 'warning'],
} as const

const age = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const timeOfDay = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

const stringsAt = async ($: EngineInterface, key: string) => {
  const stored = await $.store.get(key)

  return Array.isArray(stored)
    ? stored.filter((one): one is string => typeof one === 'string')
    : []
}

const watchedRefs = async ($: EngineInterface): Promise<Ref[]> =>
  (await stringsAt($, WATCHED)).flatMap(one => parseRef(one) ?? [])

const gh = ($: EngineInterface, query: string) =>
  $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`], {
    timeoutMs: 20_000,
  })

let isAnnouncing = true

const announce = async ($: EngineInterface, events: readonly string[]) => {
  const [first, ...rest] = events
  if (first === undefined) return
  $.ui.toast(rest.length ? `${first} (+${rest.length} more)` : first, {
    timeoutMs: 8000,
  })
  await $.ui
    .notify(events.slice(0, 5).join('\n'), { title: TITLE })
    .catch(() => undefined)
}

const fetchBoard = async ($: EngineInterface) => {
  const refs = await watchedRefs($)
  let reply: ReturnType<typeof parseReply>
  try {
    const ran = await Promise.all(buildQueries(refs).map(query => gh($, query)))
    reply = parseReply(
      ran.map(one => one.stdout),
      refs,
    )
    if (typeof reply === 'string') {
      reply = firstLine(ran.map(one => one.stderr).join('\n')) || reply
    }
  } catch (error) {
    reply = `gh did not run: ${error instanceof Error ? error.message : String(error)}`
  }
  if (typeof reply === 'string') {
    const error = reply
    // A failed poll keeps the last good lists and their time.
    await update($, board, held => ({ ...held, error }))

    return
  }
  const { viewer, ...found } = reply
  const ignored = await stringsAt($, IGNORED)
  const lists = hide(found, ignored)
  const held = await read($, board)
  const fetchedAt = await $.clock.now()
  await update($, board, () => ({
    ...lists,
    ignored: ignored.length,
    fetchedAt,
    error: null,
  }))
  // The first poll is the baseline: nothing to compare it with.
  if (!isAnnouncing || held.fetchedAt === null) return
  const events = changes(held, lists, viewer)
  const ids = departed(held, lists)
  if (ids.length > 0) {
    const ran = await gh($, buildLookup(ids)).catch(() => undefined)
    events.push(...endings(parseLookup(ran?.stdout ?? ''), viewer))
  }
  await announce($, events)
}

let queue: Promise<void> = Promise.resolve()
let isFetching = false

// One at a time: a poll in flight must not write back what a press just hid.
const enqueue = ($: EngineInterface, work: () => Promise<void>) => {
  queue = queue
    .then(work)
    .catch(error => $.ui.log(`pr-watcher: ${String(error)}`, { to: 'debug' }))

  return queue
}

const refresh = ($: EngineInterface) =>
  enqueue($, async () => {
    isFetching = true
    try {
      await fetchBoard($)
    } finally {
      isFetching = false
    }
  })

const tick = async ($: EngineInterface) => {
  if (isFetching) return
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE && pane.isPlaced)) await refresh($)
}

const editIgnored = ($: EngineInterface, edit: (list: string[]) => string[]) =>
  enqueue($, async () => {
    const list = edit(await stringsAt($, IGNORED))
    await $.store.set(IGNORED, list)
    await update($, board, held => ({
      ...hide(held, list),
      ignored: list.length,
    }))
  })

const ignore = ($: EngineInterface, key: string) =>
  editIgnored($, list => (list.includes(key) ? list : [...list, key]))

const unwatch = ($: EngineInterface, key: string) =>
  enqueue($, async () => {
    const keys = (await watchedRefs($)).map(refKey)
    await $.store.set(
      WATCHED,
      keys.filter(one => one.toLowerCase() !== key),
    )
    await update($, board, held => ({
      ...held,
      watched: held.watched.filter(pr => prKey(pr) !== key),
    }))
  })

const dismiss = async ($: EngineInterface, pr: Pr, isWatched: boolean) => {
  const key = prKey(pr)
  if (isWatched) {
    await unwatch($, key)
    $.ui.toast(`Stopped watching ${key}.`)
  } else {
    await ignore($, key)
    $.ui.toast(`Ignoring ${key}. Undo: /prs unignore ${key}`)
  }
}

export const register: Register = (on, options) => {
  const pollMs = Math.max(10, Number(options.pollSeconds) || 30) * 1000
  isAnnouncing = options.notifications !== false

  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e)
    await $.command.register({
      name: 'prs',
      description: 'Watch pull requests in a pane',
      argumentHint: '[add|remove|ignore|unignore <owner/repo#123>] [refresh]',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(pollMs, () => void tick($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb = '', target = ''] = e.args.trim().split(/\s+/)
    if (verb === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      void refresh($)

      return { text: 'Pull requests pane opened.' }
    }
    if (verb === 'refresh') {
      await refresh($)
      const held = await read($, board)

      return {
        text:
          held.error ??
          `Refreshed: ${held.mine.total} mine, ${held.reviews.total} review requests, ${held.watched.length} watched.`,
      }
    }
    if (verb === 'ignored') {
      const list = await stringsAt($, IGNORED)

      return {
        text: list.length ? `Ignored: ${list.join(', ')}` : 'Nothing is ignored.',
      }
    }
    if (verb === 'ignore' || verb === 'unignore') {
      const key = parseTarget(target)
      if (!key) return { text: USAGE }
      if (verb === 'ignore') {
        await ignore($, key)

        return { text: `Ignoring ${key}.` }
      }
      if (!(await stringsAt($, IGNORED)).includes(key)) {
        return { text: `${key} was not ignored.` }
      }
      await editIgnored($, list => list.filter(one => one !== key))
      await refresh($)

      return { text: `No longer ignoring ${key}.` }
    }

    const isRemoval = verb === 'remove' || verb === 'rm'
    const ref = parseRef(isRemoval || verb === 'add' ? target : verb)
    if (!ref) return { text: USAGE }
    const key = refKey(ref)
    const keys = (await watchedRefs($)).map(refKey)
    const rest = keys.filter(one => one.toLowerCase() !== key.toLowerCase())
    await $.store.set(WATCHED, isRemoval ? rest : [...rest, key])
    await refresh($)
    if (isRemoval) {
      return {
        text:
          rest.length === keys.length
            ? `${key} was not watched.`
            : `Stopped watching ${key}.`,
      }
    }
    const held = await read($, board)
    if (!held.missing.includes(key)) return { text: `Watching ${key}.` }
    await $.store.set(WATCHED, rest)
    await update($, board, now => ({
      ...now,
      missing: now.missing.filter(one => one !== key),
    }))

    return { text: `GitHub knows no pull request ${key}; not added.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const held = await read($, board)
    const isWide = e.props.bodyColumns >= 60
    const now = held.fetchedAt ?? 0

    const row = (pr: Pr, isWatched: boolean, hasAuthor: boolean) => {
      const [glyph, color] = pr.checks ? CHECKS[pr.checks] : ['·', 'inactive']
      const review = pr.review ? REVIEW[pr.review] : undefined

      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={color}>{glyph}</Text>{' '}
            <Link href={pr.url}>{pr.title}</Link>
          </Text>
          <Box flexDirection="row">
            <Button
              key={`hide:${pr.url}`}
              plain
              dimColor
              onPress={() => void dismiss($, pr, isWatched)}
            >
              ✕
            </Button>
            <Text dimColor wrap="truncate-end">
              {` ${isWide ? pr.repo : (pr.repo.split('/')[1] ?? pr.repo)}#${pr.number}`}
              {hasAuthor && ` · @${pr.author}`}
              {pr.state !== 'OPEN' && ` · ${pr.state.toLowerCase()}`}
              {pr.isDraft && ' · draft'}
              {review && <Text color={review[1]}>{` · ${review[0]}`}</Text>}
              {` · ${age(now - pr.updatedAt)}`}
            </Text>
          </Box>
        </Box>
      )
    }

    const section = (
      title: string,
      prs: Pr[],
      total: number,
      isWatched: boolean,
      hasAuthor: boolean,
    ) => (
      <Box flexDirection="column" marginTop={1}>
        <Text weight="bold">
          {title}{' '}
          <Text dimColor>
            {total > prs.length ? `${prs.length} of ${total}` : `${prs.length}`}
          </Text>
        </Text>
        {prs.length === 0 && <Text dimColor>{'  none'}</Text>}
        {prs.map(pr => row(pr, isWatched, hasAuthor))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {held.fetchedAt === null
            ? held.error
              ? 'never updated'
              : 'loading...'
            : `updated ${timeOfDay(held.fetchedAt)}`}
        </Text>
        {held.error && (
          <Text color="error" wrap="wrap">
            {held.error}
          </Text>
        )}
        {section('Mine', held.mine.prs, held.mine.total, false, false)}
        {section(
          'Review requested',
          held.reviews.prs,
          held.reviews.total,
          false,
          true,
        )}
        {section('Watching', held.watched, held.watched.length, true, true)}
        {held.missing.map(key => (
          <Text color="warning">{`  not found: ${key}`}</Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Button key="refresh" onPress={() => void refresh($)}>
            refresh
          </Button>
          <Text dimColor>
            {held.ignored > 0
              ? `✕ ignores a row · ${held.ignored} ignored: /prs ignored`
              : '✕ ignores a row · /prs add owner/repo#123'}
          </Text>
        </Box>
      </Box>
    )
  })
}
