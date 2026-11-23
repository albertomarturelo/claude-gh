import { expect, test } from 'claude-code/testing'

import { bySessionOrder, duration, groupWorkflows, linkedPrs, logTail, parseAheadBehind, repoFromRemote } from './register'
import type { LinkedPr } from './register'

const REPO = 'acme/app'
const PR = { number: 42, title: 'Add filing month', url: `https://github.com/${REPO}/pull/42`, author: { login: 'ana' }, isDraft: false, statusCheckRollup: [], reviewDecision: '', updatedAt: '2026-11-21T10:00:00Z' }
const job = (id: number, name: string, conclusion: string) => ({
  __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, workflowName: 'CI',
  detailsUrl: `https://github.com/${REPO}/actions/runs/100/job/${id}`,
  startedAt: '2026-11-21T10:00:00Z', completedAt: '2026-11-21T10:04:12Z',
})
const ROLLUP = [job(1, 'unit', 'SUCCESS'), job(2, 'e2e', 'FAILURE'), { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS' }]
const RUN = {
  name: 'CI', workflowName: 'CI', status: 'completed', conclusion: 'failure', number: 812, attempt: 1, headBranch: 'feat/month',
  event: 'pull_request', startedAt: '2026-11-21T10:00:00Z', updatedAt: '2026-11-21T10:04:12Z', url: `https://github.com/${REPO}/actions/runs/100`,
  jobs: [
    { databaseId: 1, name: 'unit', status: 'completed', conclusion: 'success', startedAt: '2026-11-21T10:00:00Z', completedAt: '2026-11-21T10:01:50Z', steps: [] },
    { databaseId: 2, name: 'e2e', status: 'completed', conclusion: 'failure', startedAt: '2026-11-21T10:00:00Z', completedAt: '2026-11-21T10:04:02Z',
      steps: [{ name: 'Run tests', conclusion: 'failure' }, { name: 'Upload', conclusion: 'skipped' }] },
  ],
}
const LOG = [
  'e2e\tRun tests\t2026-11-21T10:04:00.1Z Expected the export to have a month column',
  'e2e\tRun tests\t2026-11-21T10:04:00.2Z ##[error]Process completed with exit code 1.',
  'e2e\tRun tests\t2026-11-21T10:04:00.3Z Cleaning up orphan processes',
].join('\n')

// Answers the plugin's `gh` calls the way the CLI would for a repo with PR #42 open.
function ghAnswer(argv: readonly string[]): string {
  const cmd = argv.slice(1, 3).join(' ')
  if (cmd === 'repo view') return JSON.stringify({ nameWithOwner: REPO, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, viewerPermission: 'ADMIN' })
  if (cmd === 'pr merge') return ''
  if (cmd === 'pr view' && argv.includes('state,isDraft,statusCheckRollup')) return JSON.stringify(prStates[Number(argv[3])] ?? { state: 'OPEN' })
  if (cmd === 'pr view') return JSON.stringify({ ...PR, body: 'Adds the month.', state: 'OPEN', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: ROLLUP, reviews: [] })
  if (cmd === 'run view' && argv.includes('--log-failed')) return LOG
  if (cmd === 'run view') return JSON.stringify(RUN)
  if (cmd === 'run rerun') return ''
  return ''
}

const ran: string[][] = []
const toasts: string[] = []

// A fake main checkout for the plugin's `git -C <dir> …` calls; null is no repo at all.
type FakeRepo = { head: string; ahead: number; behind: number; dirty: boolean; pullFails?: string }
let repo: FakeRepo | null = null
function gitRun(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr })
  if (!repo) return fail('fatal: not a git repository')
  const cmd = args.join(' ')
  if (cmd === 'worktree list --porcelain') return ok('worktree /src/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /src/app-feat\n')
  if (cmd === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main')
  if (cmd === 'symbolic-ref --short -q HEAD') return ok(repo.head)
  if (cmd.startsWith('rev-list')) return ok(`${repo.ahead}\t${repo.behind}`)
  if (cmd.startsWith('status')) return ok(repo.dirty ? ' M src/a.ts' : '')
  if (cmd === 'remote get-url origin') return ok(`git@github.com:${REPO}.git`)
  if (cmd.startsWith('fetch') || cmd.startsWith('pull')) {
    if (repo.pullFails && (cmd.startsWith('pull') || cmd.includes(':'))) return fail(repo.pullFails)
    if (cmd.startsWith('pull') || cmd.includes('main:main')) repo.behind = 0
    return ok()
  }
  return ok()
}

// Transcript entries the way Claude Code writes them when a session links or creates a PR.
const prLink = (n: number) => ({ type: 'pr-link', prNumber: n, prUrl: `https://github.com/${REPO}/pull/${n}`, prRepository: REPO })
const prCreated = (n: number) => ({ type: 'user', toolUseResult: { gitOperation: { pr: { url: `https://github.com/${REPO}/pull/${n}`, number: n, action: 'created' } } } })
const TRANSCRIPT = '/home/u/.claude/projects/acme/session.jsonl'

// `gh pr view N --json state,isDraft,statusCheckRollup`, as the band asks for each session PR.
type PrState = { state: string; isDraft?: boolean; statusCheckRollup?: unknown[] }
let prStates: Record<number, PrState> = {}
const PENDING = [{ __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: '' }]

async function start($: any, on: any, entries: object[] = [prCreated(42)], states: Record<number, PrState> = { 42: { state: 'OPEN', statusCheckRollup: ROLLUP } }, answer: (argv: readonly string[]) => string | undefined = () => undefined) {
  prStates = states
  const text = new TextEncoder().encode(entries.map(x => JSON.stringify(x)).join('\n') + '\n')
  on('command.register', () => ({ value: { command: 'gh' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.info', () => ({ value: { transcriptPath: TRANSCRIPT } }))
  on('fs.stat', () => ({ value: { size: text.length } }))
  on('fs.read', (_: unknown, e: { offset?: number; length?: number }) => ({ value: { base64: btoa(String.fromCharCode(...text.subarray(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? text.length)))) } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-21T12:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => (ran.push([...e.argv]), {
    value: e.argv[0] === 'gh'
      ? { exitCode: 0, stdout: answer(e.argv) ?? ghAnswer(e.argv), stderr: '' }
      : e.argv[0] === 'git'
        ? gitRun(e.argv.slice(3))
        : { exitCode: 0, stdout: '', stderr: '' },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'gh', args: '' })
}

const BAND = {
  plugin: 'claude-gh',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 }, view: {},
  },
} as const

const PANE = {
  plugin: 'claude-gh',
  component: 'Pane',
  requestId: 'gh',
  props: {
    title: 'GitHub', isFocused: false, bodyColumns: 100, placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 }, view: {},
  },
} as const

test('the band and the pane show only the session PRs, never the repo lists', async ($, on) => {
  ran.length = 0
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^#42$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Issues|PRs \d|Milestones|GitHub ·/ })).toBeFalsy()
    await ui.unmount()
  }
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Session PRs/ })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'spr-acme_app-42' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'tab-issues' })).toBeFalsy()
  await pane.unmount()
  expect(ran.some(a => a[0] === 'gh' && (a[1] === 'issue' || a[1] === 'api' || (a[1] === 'pr' && a[2] === 'list')))).toBe(false)
})

test('with no session PRs the pane says so', async ($, on) => {
  await start($, on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No PRs in this session yet/ })).toBeTruthy()
  await ui.unmount()
})

test('Open on GitHub opens the PR in the browser through gh --web', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  await ui.press({ key: 'open-web' })
  expect(ran).toContainEqual(['gh', 'pr', 'view', '42', '--repo', 'acme/app', '--web'])
  await ui.unmount()
})

test('a PR groups its Actions jobs by workflow; a workflow shows its jobs, failed steps and log', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  expect(await ui.find({ type: 'Text', text: /1 of 2 jobs failed/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /vercel/ })).toBeTruthy()

  await ui.press({ key: 'wf-100' })
  expect(await ui.find({ type: 'Text', text: /run #812/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✗ Run tests/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /month column/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /orphan/ })).toBeFalsy()
  await ui.unmount()
})

test('re-running failed jobs asks first, then calls gh run rerun --failed', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  await ui.press({ key: 'wf-100' })
  await ui.press({ key: 'rerun' })
  expect(ran.some(a => a[1] === 'run' && a[2] === 'rerun')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /This starts CI again/ })).toBeTruthy()
  await ui.press({ key: 'rerun-yes' })
  expect(ran).toContainEqual(['gh', 'run', 'rerun', '100', '--failed', '--repo', 'acme/app'])
  await ui.unmount()
})

test('refresh reloads the PR without blanking it', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  const views = ran.filter(a => a[1] === 'pr' && a[2] === 'view').length
  await ui.press({ key: 'refresh-detail' })
  expect(ran.filter(a => a[1] === 'pr' && a[2] === 'view').length).toBe(views + 1)
  expect(await ui.find({ type: 'Text', text: /Add filing month/ })).toBeTruthy()
  await ui.unmount()
})

test('helpers: log tail stops at the error, durations, grouping', () => {
  expect(logTail(LOG)).toEqual(['Expected the export to have a month column', 'Process completed with exit code 1.'])
  expect(duration('2026-11-21T10:00:00Z', '2026-11-21T10:04:12Z')).toBe('4m 12s')
  expect(duration('2026-11-21T10:00:00Z', '2026-11-21T10:00:41Z')).toBe('41s')
  const { workflows, others } = groupWorkflows([
    { name: 'a', result: 'pass', workflow: 'CI', runId: 1, startedAt: null, completedAt: null },
    { name: 'b', result: 'pending', workflow: 'CI', runId: 1, startedAt: null, completedAt: null },
    { name: 'c', result: 'pass', workflow: '', runId: null, startedAt: null, completedAt: null },
  ])
  expect(workflows).toHaveLength(1)
  expect(workflows[0]).toMatchObject({ name: 'CI', result: 'pending', total: 2, done: 1 })
  expect(others).toHaveLength(1)
})

test('the band shows the newest session PRs and a +N for the rest, leaving merged ones out', async ($, on) => {
  await start($, on, [1, 2, 3, 4, 5, 6, 7].map(prCreated), { 7: { state: 'OPEN', statusCheckRollup: PENDING }, 3: { state: 'MERGED' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /session/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^#7$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^#1$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^#3$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /\+2/ })).toBeTruthy()
  await ui.unmount()
})

test('with hideMergedSessionPrs off, merged session PRs stay on the band', { options: { hideMergedSessionPrs: false } }, async ($, on) => {
  await start($, on, [prLink(3)], { 3: { state: 'MERGED' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^#3$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeTruthy()
  await ui.unmount()
})

test('the pane flips hideMergedSessionPrs through /config', async ($, on) => {
  const set: unknown[] = []
  // Stands in for the settings writer beneath the plugins.
  on('config.set', { key: 'claude-gh.hideMergedSessionPrs' }, (_: unknown, e) => (set.push([e.key, e.value]), { value: e.value }))
  // The answer to $.config.list(), which the hook's own type doesn't describe.
  on('config.list', (): any => ({ value: [{ key: 'claude-gh.hideMergedSessionPrs', label: 'Hide merged session PRs', kind: 'toggle', value: true, provider: { plugin: 'claude-gh', tier: 'user' }, isLocked: false }] }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Merged PRs hidden/ })).toBeTruthy()
  await ui.press({ key: 'toggle-merged' })
  expect(set).toEqual([['claude-gh.hideMergedSessionPrs', false]])
  await ui.unmount()
})

test('helpers: GitHub remotes and ahead/behind counts', () => {
  expect(repoFromRemote('git@github.com:acme/app.git')).toBe('acme/app')
  expect(repoFromRemote('https://github.com/acme/app')).toBe('acme/app')
  expect(repoFromRemote('https://gitlab.com/acme/app.git')).toBeNull()
  expect(parseAheadBehind('1\t3')).toEqual([1, 3])
})

async function startWithRepo($: any, on: any, fake: FakeRepo) {
  ran.length = 0
  toasts.length = 0
  repo = fake
  await start($, on)
  return $.ui.mount({ ...BAND, surface: 'terminal' })
}

test('the band starts with the base branch, and pressing it pulls the main checkout', async ($, on) => {
  const ui = await startWithRepo($, on, { head: 'main', ahead: 0, behind: 3, dirty: false })
  expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /↓3/ })).toBeTruthy()
  await ui.press({ key: 'band-base' })
  expect(ran).toContainEqual(['git', '-C', '/src/app', 'pull', '--ff-only', '--quiet', 'origin', 'main'])
  expect(toasts).toContain('Synced main: 3 new commits')
  expect(await ui.find({ type: 'Text', text: /↓/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /✓/ })).toBeTruthy()
  await ui.unmount()
})

test('with another branch out, syncing fast-forwards main without switching', async ($, on) => {
  const ui = await startWithRepo($, on, { head: 'feat/x', ahead: 0, behind: 2, dirty: true })
  await ui.press({ key: 'band-base' })
  expect(ran).toContainEqual(['git', '-C', '/src/app', 'fetch', '--quiet', 'origin', 'main:main'])
  expect(ran.some(a => a[0] === 'git' && a[3] === 'pull')).toBe(false)
  await ui.unmount()
})

test('a main checkout with uncommitted changes is never pulled', async ($, on) => {
  const ui = await startWithRepo($, on, { head: 'main', ahead: 0, behind: 1, dirty: true })
  expect(await ui.find({ type: 'Text', text: /✎/ })).toBeTruthy()
  await ui.press({ key: 'band-base' })
  expect(ran.some(a => a[0] === 'git' && a[3] === 'pull')).toBe(false)
  expect(toasts.join('\n')).toMatch(/uncommitted changes/)
  await ui.unmount()
})

test('a diverged main is left alone and says why', async ($, on) => {
  const ui = await startWithRepo($, on, { head: 'main', ahead: 1, behind: 2, dirty: false, pullFails: 'fatal: Not possible to fast-forward, aborting.' })
  expect(await ui.find({ type: 'Text', text: /↑1/ })).toBeTruthy()
  await ui.press({ key: 'band-base' })
  expect(toasts).toContain("Couldn't sync main: it has 1 local commit origin doesn't")
  await ui.unmount()
})

test('outside a git repo there is no base branch on the band', async ($, on) => {
  ran.length = 0
  repo = null
  await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^#42$/ })).toBeTruthy()
  await ui.unmount()
})

test('session PRs are ordered open first, then created, then newest', () => {
  const pr = (number: number, state: string | null, created = true) =>
    ({ number, url: '', repo: REPO, created, state, isDraft: false, checks: null })
  const sorted = [pr(1, 'OPEN'), pr(5, 'MERGED'), pr(3, 'OPEN', false), pr(4, 'OPEN'), pr(2, 'CLOSED')].sort(bySessionOrder)
  expect(sorted.map(p => p.number)).toEqual([4, 1, 3, 5, 2])
})

test('merging a PR from the pane asks for an allowed method first, then calls gh pr merge', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  await ui.press({ key: 'merge' })
  expect(ran.some(a => a[1] === 'pr' && a[2] === 'merge')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Merge #42 into main\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'merge-merge' })).toBeFalsy()
  await ui.press({ key: 'merge-squash' })
  expect(ran).toContainEqual(['gh', 'pr', 'merge', '42', '--repo', 'acme/app', '--squash'])
  await ui.unmount()
})

test('merging a PR into main pulls the main checkout afterwards', async ($, on) => {
  ran.length = 0
  toasts.length = 0
  repo = { head: 'main', ahead: 0, behind: 0, dirty: false }
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  await ui.press({ key: 'merge' })
  repo.behind = 1 // the merge commit lands on origin/main
  await ui.press({ key: 'merge-squash' })
  const merged = ran.findIndex(a => a[1] === 'pr' && a[2] === 'merge')
  const pulled = ran.findIndex(a => a[0] === 'git' && a[3] === 'pull')
  expect(merged).toBeGreaterThan(-1)
  expect(pulled).toBeGreaterThan(merged)
  expect(toasts).toContain('Synced main: 1 new commit')
  await ui.unmount()
  repo = null
})

test('an admin can turn on the bypass, which merges with --admin', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'spr-acme_app-42' })
  await ui.press({ key: 'merge' })
  await ui.press({ key: 'merge-bypass' })
  expect(await ui.find({ type: 'Text', text: /will be bypassed/ })).toBeTruthy()
  await ui.press({ key: 'merge-rebase' })
  expect(ran).toContainEqual(['gh', 'pr', 'merge', '42', '--repo', 'acme/app', '--rebase', '--admin'])
  await ui.unmount()
})

test('a PR the session created stays marked as created when a pr-link mentions it later', () => {
  const list: LinkedPr[] = []
  for (const entry of [prLink(5), prCreated(9), prLink(9), { type: 'assistant' }, prLink(5)]) linkedPrs(list, entry)
  expect(list).toEqual([
    { url: `https://github.com/${REPO}/pull/5`, number: 5, repo: REPO, created: false },
    { url: `https://github.com/${REPO}/pull/9`, number: 9, repo: REPO, created: true },
  ])
})

test('session PRs come from the transcript, with their state from gh', async ($, on) => {
  ran.length = 0
  await start($, on, [prCreated(42), prLink(8)], { 42: { state: 'OPEN', statusCheckRollup: ROLLUP }, 8: { state: 'CLOSED' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^#42$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✗/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /closed/ })).toBeTruthy()
  expect(ran).toContainEqual(['gh', 'pr', 'view', '8', '--repo', REPO, '--json', 'state,isDraft,statusCheckRollup'])
  await ui.unmount()
})
