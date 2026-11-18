import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'pr-watcher',
  component: 'Pane',
  requestId: 'pr-watcher',
  props: {
    title: 'Pull requests',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const head = (oid: string, state: string, login: string | null = 'me') => ({
  nodes: [
    {
      commit: {
        oid,
        committedDate: '2026-11-18T09:00:00Z',
        author: { user: login ? { login } : null },
        statusCheckRollup: { state },
      },
    },
  ],
})

// A comment or a review as GitHub answers it: `id` is what a poll compares.
const by = (login: string, id: string, extra: object = {}) => ({
  nodes: [
    {
      id,
      createdAt: '2026-11-18T11:00:00Z',
      submittedAt: '2026-11-18T11:00:00Z',
      author: { __typename: 'User', login },
      ...extra,
    },
  ],
})

const pr = (number: number, title: string, extra: object = {}) => ({
  id: `PR_${number}`,
  number,
  title,
  url: `https://github.com/acme/app/pull/${number}`,
  isDraft: false,
  state: 'OPEN',
  reviewDecision: null,
  updatedAt: '2026-11-18T10:00:00Z',
  repository: { nameWithOwner: 'acme/app' },
  author: { login: 'octo' },
  comments: { nodes: [] },
  reviews: { nodes: [] },
  commits: head('c1', 'SUCCESS'),
  ...extra,
})

const found = (mine: object[], reviews: object[] = [], more: object = {}) => ({
  data: {
    viewer: { login: 'me' },
    mine: { issueCount: mine.length, nodes: mine },
    reviews: { issueCount: reviews.length, nodes: reviews },
    ...more,
  },
})

type Gh = { stdout?: object; stderr?: string }

// Stands for the engine beneath the mod: gh answers what `gh.reply` holds now to
// each of a poll's requests, and `gh.lookup` to how the PRs that left a list ended.
const engine = (on: On, isPlaced = true) => {
  const gh = { reply: {} as Gh, lookup: {} as Gh, queries: [] as string[], polls: 0 }
  const toasts: string[] = []
  const notes: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notes.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  const stored: Record<string, unknown> = {}
  const clock = mock.clock(on, { now: Date.parse('2026-11-18T12:00:00Z') })
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'prs' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [
      {
        id: 'pr-watcher',
        title: 'Pull requests',
        isShown: isPlaced,
        isFocused: false,
        isPlaced,
      },
    ],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const query = (e.argv.at(-1) ?? '').replace(/^query=/, '')
    gh.queries.push(query)
    if (query.includes('mine: search(')) gh.polls += 1
    const { stdout, stderr = '' } = query.startsWith('query { nodes(')
      ? gh.lookup
      : gh.reply

    return {
      value: {
        exitCode: stderr ? 1 : 0,
        stdout: stdout ? JSON.stringify(stdout) : '',
        stderr,
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return { gh, clock, stored, toasts, notes }
}

test('the pane lists my PRs and review requests, on every surface', async ($, on) => {
  const { gh } = engine(on)
  gh.reply = {
    stdout: found(
      [pr(7, 'Fix the flux', { reviewDecision: 'APPROVED' })],
      [pr(9, 'Add the widget', { isDraft: true, author: { login: 'hubot' } })],
    ),
  }

  await $.session.start(START)
  const ran = await $.command.run({ command: 'prs', args: 'refresh' })
  expect(ran.text).toBe('Refreshed: 1 mine, 1 review requests, 0 watched.')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Link', text: /Fix the flux/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /app#7 · approved · 2h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /app#9 · @hubot · draft · 2h/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/prs add watches a PR, and a PR GitHub does not know is not kept', async ($, on) => {
  const { gh, stored } = engine(on)
  await $.session.start(START)

  gh.reply = {
    stdout: found([], [], {
      w0: { pullRequest: pr(3, 'Someone else, watched', { state: 'MERGED' }) },
    }),
  }
  const added = await $.command.run({
    command: 'prs',
    args: 'add https://github.com/acme/app/pull/3/files',
  })
  expect(added.text).toBe('Watching acme/app#3.')
  expect(gh.queries.at(-1)).toContain(
    'w0: repository(owner: "acme", name: "app") { pullRequest(number: 3)',
  )
  expect(stored.watched).toEqual(['acme/app#3'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /app#3 · @octo · merged/ })).toBeDefined()

  gh.reply = {
    stdout: {
      ...found([], [], {
        w0: { pullRequest: pr(3, 'Someone else, watched') },
        w1: null,
      }),
      errors: [{ message: 'Could not resolve to a Repository' }],
    },
    stderr: 'gh: Could not resolve to a Repository',
  }
  const refused = await $.command.run({ command: 'prs', args: 'nope/gone#1' })
  expect(refused.text).toBe('GitHub knows no pull request nope/gone#1; not added.')
  expect(stored.watched).toEqual(['acme/app#3'])

  const removed = await $.command.run({ command: 'prs', args: 'rm ACME/app#3' })
  expect(removed.text).toBe('Stopped watching ACME/app#3.')
  expect(stored.watched).toEqual([])

  const usage = await $.command.run({ command: 'prs', args: 'add nonsense' })
  expect(usage.text).toMatch(/^Usage:/)
  await ui.unmount()
})

test('a failed poll keeps the last list and says why', async ($, on) => {
  const { gh } = engine(on)
  gh.reply = { stdout: found([pr(7, 'Fix the flux')]) }
  await $.session.start(START)
  await $.command.run({ command: 'prs', args: 'refresh' })

  gh.reply = { stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\n' }
  await $.command.run({ command: 'prs', args: 'refresh' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /gh auth login/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /Fix the flux/ })).toBeDefined()
  await ui.unmount()
})

test('the timer polls at the configured interval while the pane is placed', { options: { pollSeconds: 45 } }, async ($, on) => {
  const { gh, clock } = engine(on)
  gh.reply = { stdout: found([]) }
  await $.session.start(START)
  await clock.settle()
  expect(gh.polls).toBe(1)

  await clock.advance(44_000)
  expect(gh.polls).toBe(1)
  await clock.advance(1_000)
  expect(gh.polls).toBe(2)
})

test('the timer does not poll for a pane nobody sees', async ($, on) => {
  const { gh, clock } = engine(on, false)
  gh.reply = { stdout: found([]) }
  await $.session.start(START)
  await clock.settle()
  await clock.advance(90_000)

  expect(gh.polls).toBe(1)
})

test('an ignored PR or repo is hidden until it is unignored', async ($, on) => {
  const { gh, stored } = engine(on)
  const other = { repository: { nameWithOwner: 'acme/noise' } }
  gh.reply = {
    stdout: found(
      [pr(7, 'Fix the flux'), pr(8, 'Tune the flux')],
      [pr(9, 'Add the widget'), pr(4, 'Bump a thing', other)],
    ),
  }
  await $.session.start(START)
  await $.command.run({ command: 'prs', args: 'refresh' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    stored.ignored = []
    await $.command.run({ command: 'prs', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })

    // The row's own mark ignores it at once, with no poll in between.
    const polls = gh.polls
    await ui.press({ key: 'hide:https://github.com/acme/app/pull/7' })
    expect(stored.ignored).toEqual(['acme/app#7'])
    expect(gh.polls).toBe(polls)
    expect(await ui.find({ type: 'Link', text: /Fix the flux/ })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: /Tune the flux/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 ignored/ })).toBeDefined()

    const ignored = await $.command.run({ command: 'prs', args: 'ignore Acme/Noise' })
    expect(ignored.text).toBe('Ignoring acme/noise.')
    expect(await ui.find({ type: 'Link', text: /Bump a thing/ })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: /Add the widget/ })).toBeDefined()

    // A poll does not bring an ignored row back.
    const ran = await $.command.run({ command: 'prs', args: 'refresh' })
    expect(ran.text).toBe('Refreshed: 1 mine, 1 review requests, 0 watched.')
    expect(await ui.find({ type: 'Link', text: /Fix the flux/ })).toBeUndefined()

    const listed = await $.command.run({ command: 'prs', args: 'ignored' })
    expect(listed.text).toBe('Ignored: acme/app#7, acme/noise')

    const back = await $.command.run({
      command: 'prs',
      args: 'unignore https://github.com/acme/app/pull/7',
    })
    expect(back.text).toBe('No longer ignoring acme/app#7.')
    expect(await ui.find({ type: 'Link', text: /Fix the flux/ })).toBeDefined()
    expect(stored.ignored).toEqual(['acme/noise'])
    await ui.unmount()
  }
})

test("a watched row's mark stops watching it", async ($, on) => {
  const { gh, stored } = engine(on)
  await $.session.start(START)
  gh.reply = {
    stdout: found([], [], { w0: { pullRequest: pr(3, 'Someone else, watched') } }),
  }
  await $.command.run({ command: 'prs', args: 'acme/app#3' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'hide:https://github.com/acme/app/pull/3' })

  expect(stored.watched).toEqual([])
  expect(stored.ignored).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: /Someone else/ })).toBeUndefined()
  await ui.unmount()
})

const poll = ($: { command: { run: (run: { command: string; args: string }) => Promise<unknown> } }) =>
  $.command.run({ command: 'prs', args: 'refresh' })

test("someone else's comment, review and push are announced; mine and a bot's are not", async ($, on) => {
  const { gh, toasts, notes } = engine(on)
  gh.reply = { stdout: found([pr(7, 'Fix the flux')], [pr(9, 'Add the widget')]) }
  await $.session.start(START)
  await poll($)
  expect(toasts).toEqual([])

  gh.reply = {
    stdout: found(
      [
        pr(7, 'Fix the flux', {
          comments: by('bob', 'IC_1'),
          reviews: by('alice', 'PRR_1', { state: 'APPROVED' }),
        }),
      ],
      [pr(9, 'Add the widget', { commits: head('c2', 'SUCCESS', 'carol') })],
    ),
  }
  await poll($)
  expect(toasts).toEqual(['@bob commented on app#7 · Fix the flux (+2 more)'])
  expect(notes).toEqual([
    [
      '@bob commented on app#7 · Fix the flux',
      '@alice approved app#7 · Fix the flux',
      '@carol pushed to app#9 · Add the widget',
    ].join('\n'),
  ])

  // The same answer again is no news.
  await poll($)
  expect(toasts).toHaveLength(1)

  gh.reply = {
    stdout: found(
      [
        pr(7, 'Fix the flux', {
          comments: by('Me', 'IC_2'),
          reviews: by('rabbit', 'PRR_2', {
            state: 'COMMENTED',
            author: { __typename: 'Bot', login: 'rabbit' },
          }),
          // A commit tied to no account, on a PR of mine, counts as mine.
          author: { login: 'me' },
          commits: head('c3', 'SUCCESS', null),
        }),
      ],
      [pr(9, 'Add the widget', { commits: head('c2', 'SUCCESS', 'carol') })],
    ),
  }
  await poll($)
  expect(toasts).toHaveLength(1)

  // Deleting my comment surfaces bob's older one again: not news either.
  gh.reply = {
    stdout: found([
      pr(7, 'Fix the flux', {
        comments: by('bob', 'IC_1', { createdAt: '2026-11-18T10:30:00Z' }),
        reviews: by('rabbit', 'PRR_2', { state: 'COMMENTED' }),
        author: { login: 'me' },
        commits: head('c3', 'SUCCESS', null),
      }),
    ]),
  }
  await poll($)
  expect(toasts).toHaveLength(1)
})

test('CI finishing is announced for my PRs, not for review requests', async ($, on) => {
  const { gh, toasts } = engine(on)
  const lists = (state: string) =>
    found(
      [pr(7, 'Fix the flux', { commits: head('c1', state) })],
      [pr(9, 'Add the widget', { commits: head('c1', state) })],
    )
  gh.reply = { stdout: lists('PENDING') }
  await $.session.start(START)
  await poll($)

  gh.reply = { stdout: lists('FAILURE') }
  await poll($)
  expect(toasts).toEqual(['CI failed on app#7 · Fix the flux'])

  gh.reply = { stdout: lists('PENDING') }
  await poll($)
  gh.reply = { stdout: lists('SUCCESS') }
  await poll($)
  expect(toasts).toEqual([
    'CI failed on app#7 · Fix the flux',
    'CI passed on app#7 · Fix the flux',
  ])
})

test('a PR someone else merged or closed is announced once it leaves its list', async ($, on) => {
  const { gh, toasts } = engine(on)
  const three = [pr(7, 'Fix the flux'), pr(8, 'Tune the flux'), pr(6, 'Slid out')]
  gh.reply = { stdout: found(three, [pr(9, 'Add the widget')]) }
  await $.session.start(START)
  await poll($)

  const actor = (login: string) => ({ nodes: [{ actor: { login } }] })
  gh.reply = { stdout: found([]) }
  gh.lookup = {
    stdout: {
      data: {
        nodes: [
          pr(7, 'Fix the flux', { state: 'MERGED', mergedBy: { login: 'bob' } }),
          pr(8, 'Tune the flux', { state: 'CLOSED', timelineItems: actor('me') }),
          pr(6, 'Slid out'),
          pr(9, 'Add the widget', { state: 'CLOSED', timelineItems: actor('dana') }),
        ],
      },
    },
  }
  await poll($)

  expect(gh.queries.at(-1)).toContain('nodes(ids: ["PR_7","PR_8","PR_6","PR_9"])')
  expect(toasts).toEqual(['@bob merged app#7 · Fix the flux (+1 more)'])

  // Gone is gone: the next poll asks nothing more about them.
  const asked = gh.queries.length
  await poll($)
  expect(gh.queries).toHaveLength(asked + 2)
})

test('an ignored PR and a first sighting announce nothing', async ($, on) => {
  const { gh, toasts } = engine(on)
  gh.reply = { stdout: found([pr(7, 'Fix the flux')]) }
  await $.session.start(START)
  await poll($)
  await $.command.run({ command: 'prs', args: 'ignore acme/app#7' })

  gh.reply = {
    stdout: found([
      pr(7, 'Fix the flux', { comments: by('bob', 'IC_1') }),
      pr(8, 'New here', { comments: by('bob', 'IC_2') }),
    ]),
  }
  await poll($)

  expect(toasts).toEqual([])
  expect(gh.queries.some(query => query.startsWith('query { nodes('))).toBe(false)
})

test('notifications can be switched off', { options: { notifications: false } }, async ($, on) => {
  const { gh, toasts, notes } = engine(on)
  gh.reply = { stdout: found([pr(7, 'Fix the flux')]) }
  await $.session.start(START)
  await poll($)

  gh.reply = { stdout: found([pr(7, 'Fix the flux', { comments: by('bob', 'IC_1') })]) }
  await poll($)

  expect(toasts).toEqual([])
  expect(notes).toEqual([])
})

test('a board an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { mine: [7] }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /loading/ })).toBeDefined()
  await ui.unmount()
})
