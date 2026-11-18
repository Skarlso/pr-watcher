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

const pr = (number: number, title: string, extra: object = {}) => ({
  number,
  title,
  url: `https://github.com/acme/app/pull/${number}`,
  isDraft: false,
  state: 'OPEN',
  reviewDecision: null,
  updatedAt: '2026-11-18T10:00:00Z',
  repository: { nameWithOwner: 'acme/app' },
  author: { login: 'octo' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...extra,
})

const found = (mine: object[], reviews: object[] = [], more: object = {}) => ({
  data: {
    mine: { issueCount: mine.length, nodes: mine },
    reviews: { issueCount: reviews.length, nodes: reviews },
    ...more,
  },
})

type Gh = { stdout?: object; stderr?: string }

// Stands for the engine beneath the mod: gh answers what `gh.reply` holds now.
const engine = (on: On, isPlaced = true) => {
  const gh = { reply: {} as Gh, queries: [] as string[] }
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
    gh.queries.push(e.argv.at(-1) ?? '')
    const { stdout, stderr = '' } = gh.reply

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

  return { gh, clock, stored }
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
  expect(gh.queries).toHaveLength(1)

  await clock.advance(44_000)
  expect(gh.queries).toHaveLength(1)
  await clock.advance(1_000)
  expect(gh.queries).toHaveLength(2)
})

test('the timer does not poll for a pane nobody sees', async ($, on) => {
  const { gh, clock } = engine(on, false)
  gh.reply = { stdout: found([]) }
  await $.session.start(START)
  await clock.settle()
  await clock.advance(90_000)

  expect(gh.queries).toHaveLength(1)
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
    const polls = gh.queries.length
    await ui.press({ key: 'hide:https://github.com/acme/app/pull/7' })
    expect(stored.ignored).toEqual(['acme/app#7'])
    expect(gh.queries).toHaveLength(polls)
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

test('a board an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { mine: [7] }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /loading/ })).toBeDefined()
  await ui.unmount()
})
