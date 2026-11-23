import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderChildren } from 'claude-code'

import type { BaseView, CheckResult, CheckRow, Checks, Detail, MergeMethod, ReviewRow, RunJob, RunView, SessionPr } from '../types'

/** The `$` every hook receives. */
type Dollar = Parameters<Hook<'session.start'>>[0]

const PANE = 'gh'
/** How often origin is asked where the base branch stands. */
const FETCH_MS = 2 * 60_000
const SESSION_PRS_MS = 15_000
/** How often an open workflow run (every tick) or a PR with running checks (every other tick) refreshes. */
const LIVE_MS = 10_000
const LOG_LINES = 12
/** Session PRs shown on the band; the rest are behind a "+N" that opens the pane's list. */
const BAND_PRS = 4

const detail = atom({ plugin: 'claude-gh', key: 'detail' } as const, null as Detail | null, { shape: 'detail-6' })
const sessionPrs = atom({ plugin: 'claude-gh', key: 'sessionPrs' } as const, [] as SessionPr[], { shape: 'session-prs-1' })
const run = atom({ plugin: 'claude-gh', key: 'run' } as const, null as RunView | null, { shape: 'run-1' })
const base = atom({ plugin: 'claude-gh', key: 'base' } as const, null as BaseView | null, { shape: 'base-1' })

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

function checkRow(c: Record<string, unknown>): CheckRow {
  const conclusion = String(c.conclusion ?? '').toUpperCase()
  const state = String(c.state ?? '').toUpperCase()
  const status = String(c.status ?? '').toUpperCase()
  const row = {
    name: String(c.name ?? c.context ?? 'check'),
    workflow: String(c.workflowName ?? ''),
    // Actions jobs link to .../actions/runs/<run id>/job/<job id>.
    runId: Number(/\/actions\/runs\/(\d+)/.exec(String(c.detailsUrl ?? ''))?.[1]) || null,
    startedAt: (c.startedAt as string) || null,
    completedAt: (c.completedAt as string) || null,
  }
  if (FAILED.has(conclusion) || state === 'FAILURE' || state === 'ERROR') return { ...row, result: 'fail' }
  if (status ? status !== 'COMPLETED' : state === 'PENDING' || state === 'EXPECTED') return { ...row, result: 'pending' }
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return { ...row, result: 'skip' }
  return { ...row, result: 'pass' }
}

/** Result of an Actions job or run, from gh's lowercase status and conclusion. */
function actionsResult(status: unknown, conclusion: unknown): CheckResult {
  if (String(status ?? '').toLowerCase() !== 'completed') return 'pending'
  const c = String(conclusion ?? '').toUpperCase()
  if (FAILED.has(c)) return 'fail'
  if (c === 'SKIPPED' || c === 'NEUTRAL') return 'skip'
  return 'pass'
}

export type WorkflowGroup = {
  runId: number
  name: string
  result: CheckResult
  total: number
  failed: number
  done: number
  startedAt: string | null
  completedAt: string | null
}

/** Groups a PR's Actions jobs by run; checks from other apps are returned apart. */
export function groupWorkflows(checks: CheckRow[]): { workflows: WorkflowGroup[]; others: CheckRow[] } {
  const byRun = new Map<number, CheckRow[]>()
  const others: CheckRow[] = []
  for (const c of checks) {
    if (c.runId) byRun.set(c.runId, [...(byRun.get(c.runId) ?? []), c])
    else others.push(c)
  }
  const workflows = [...byRun].map(([runId, jobs]): WorkflowGroup => {
    const failed = jobs.filter(j => j.result === 'fail').length
    const pending = jobs.filter(j => j.result === 'pending').length
    const starts = jobs.map(j => j.startedAt).filter(Boolean).sort() as string[]
    const ends = jobs.map(j => j.completedAt).filter(Boolean).sort() as string[]
    return {
      runId,
      name: jobs[0]!.workflow || jobs[0]!.name,
      result: failed ? 'fail' : pending ? 'pending' : jobs.every(j => j.result === 'skip') ? 'skip' : 'pass',
      total: jobs.length,
      failed,
      done: jobs.length - pending,
      startedAt: starts[0] ?? null,
      completedAt: pending ? null : ends[ends.length - 1] ?? null,
    }
  })
  const order: CheckResult[] = ['fail', 'pending', 'pass', 'skip']
  workflows.sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result))
  return { workflows, others }
}

/** "41s", "4m 12s", "1h 5m". */
export function duration(from: string | null, to: string | number | null): string {
  if (!from || to === null) return ''
  const ms = (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from)
  if (!(ms >= 0)) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

/**
 * The end of a failed job's log: up to the last `##[error]` line, without
 * gh's "job<TAB>step<TAB>timestamp" prefix or terminal colors.
 */
export function logTail(raw: string, max = LOG_LINES): string[] {
  const lines = raw.split('\n').map(line => {
    const text = line.split('\t').slice(2).join('\t') || line
    return text.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
  }).filter(l => l.trim())
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.includes('##[error]')) { end = i + 1; break }
  return lines.slice(Math.max(0, end - max), end).map(l => l.replace('##[error]', ''))
}

function ago(iso: string | null, now: number): string {
  if (!iso) return ''
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 60) return `${min}m`
  if (min < 48 * 60) return `${Math.round(min / 60)}h`
  return `${Math.round(min / 1440)}d`
}

/** Safe in a React key. */
function safeKey(s: string): string {
  return s.replace(/[^\w.-]/g, '_')
}

// Module variables start over on every reload; session.start sets them again.
let cwd: string | undefined
let isPaneOpen = false
let liveTick = 0
let isBaseLoading = false
/** The `hideMergedSessionPrs` option; a change to it reloads the plugin, so `register` sets it again. */
let hideMerged = true

async function gh($: Dollar, args: string[]): Promise<any> {
  const r = await $.process.run(['gh', ...args], { cwd, timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout || `gh exited with ${r.exitCode}`).trim().split('\n')[0])
  return JSON.parse(r.stdout)
}

/** `git -C dir …`: whether it worked, its output, and the first line of why not. */
async function git($: Dollar, dir: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; out: string; why: string }> {
  const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs })
  return { ok: r.exitCode === 0, out: r.stdout.trim(), why: (r.stderr || r.stdout).trim().split('\n')[0] || `git exited with ${r.exitCode}` }
}

/** `owner/repo` of a GitHub remote URL (https or ssh); null for anything else. */
export function repoFromRemote(url: string): string | null {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null
}

/** `git rev-list --left-right --count a...b` → [ahead, behind]. */
export function parseAheadBehind(out: string): [number, number] {
  const [a, b] = out.trim().split(/\s+/).map(Number)
  return [a || 0, b || 0]
}

/**
 * Reads where the base branch stands in the main checkout; with `fetch`, asks
 * origin first. A fetch only moves remote refs, so no worktree changes.
 */
async function loadBase($: Dollar, fetch: boolean): Promise<void> {
  if (isBaseLoading || !cwd) return
  isBaseLoading = true
  try {
    const list = await git($, cwd, ['worktree', 'list', '--porcelain'])
    const dir = list.ok ? list.out.split('\n').find(l => l.startsWith('worktree '))?.slice('worktree '.length) : undefined
    if (!dir) {
      await update($, base, () => null)
      return
    }
    const before = await read($, base)
    let branch = before?.dir === dir ? before.branch : ''
    if (!branch) {
      const head = await git($, dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      branch = head.ok ? head.out.replace(/^origin\//, '') : ''
    }
    if (!branch) {
      const r = await $.process.run(['gh', 'repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { cwd: dir, timeoutMs: 20_000 })
      branch = r.exitCode === 0 ? r.stdout.trim() : ''
    }
    if (!branch) branch = 'main'
    const fetched = fetch ? await git($, dir, ['fetch', '--quiet', 'origin', branch], 30_000) : undefined
    const [counts, head, status, remote] = await Promise.all([
      git($, dir, ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`]),
      git($, dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git($, dir, ['status', '--porcelain', '--untracked-files=no']),
      git($, dir, ['remote', 'get-url', 'origin']),
    ])
    const [ahead, behind] = counts.ok ? parseAheadBehind(counts.out) : [0, 0]
    const isCheckedOut = head.ok && head.out === branch
    const next: BaseView = {
      branch, dir, ahead, behind, isCheckedOut,
      repo: remote.ok ? repoFromRemote(remote.out) : null,
      isDirty: isCheckedOut && status.ok && status.out !== '',
      sync: before?.dir === dir ? before.sync : 'idle',
      error: fetched && !fetched.ok ? fetched.why : fetched ? null : before?.error ?? null,
    }
    if (JSON.stringify(before) !== JSON.stringify(next)) await update($, base, () => next)
  } finally {
    isBaseLoading = false
  }
}

/**
 * Brings the base branch up to origin's, fast-forward only: `git pull --ff-only`
 * when the main checkout has it out (and is clean), else `git fetch origin b:b`.
 * Never merges, rebases or resets; says why when it can't.
 */
async function syncBase($: Dollar): Promise<void> {
  const b = await read($, base)
  if (!b || b.sync === 'syncing') return
  if (b.isDirty) {
    await $.ui.toast(`Not syncing ${b.branch}: ${b.dir} has uncommitted changes`)
    return
  }
  await update($, base, x => (x ? { ...x, sync: 'syncing' as const } : x))
  const r = b.isCheckedOut
    ? await git($, b.dir, ['pull', '--ff-only', '--quiet', 'origin', b.branch], 60_000)
    : await git($, b.dir, ['fetch', '--quiet', 'origin', `${b.branch}:${b.branch}`], 60_000)
  await update($, base, x => (x ? { ...x, sync: 'idle' as const } : x))
  await loadBase($, false)
  const after = await read($, base)
  if (!r.ok) {
    const diverged = after && after.ahead && after.behind
    await $.ui.toast(`Couldn't sync ${b.branch}: ${diverged ? `it has ${after.ahead} local commit${after.ahead === 1 ? '' : 's'} origin doesn't` : r.why}`)
    return
  }
  const gained = b.behind - (after?.behind ?? 0)
  await $.ui.toast(gained > 0 ? `Synced ${b.branch}: ${gained} new commit${gained === 1 ? '' : 's'}` : `${b.branch} is up to date`)
}

/** Session PRs order everywhere: open first, then the ones the session created, then the newest. */
export function bySessionOrder(a: SessionPr, b: SessionPr): number {
  const isDone = (p: SessionPr) => p.state === 'MERGED' || p.state === 'CLOSED'
  return Number(isDone(a)) - Number(isDone(b)) || Number(b.created) - Number(a.created) || b.number - a.number
}

/** The option's `/config` key: `<plugin>.<field>`, the plugin named however it was installed. */
const HIDE_MERGED_FIELD = 'hideMergedSessionPrs'

/** Flips `hideMergedSessionPrs` as `/config` would; the plugin reloads with the new value. */
async function toggleHideMerged($: Dollar): Promise<void> {
  const row = (await $.config.list()).find(r => r.key.endsWith(`.${HIDE_MERGED_FIELD}`))
  if (!row) return
  const r = await $.config.set({ key: row.key, value: !hideMerged })
  if (r.deny) await $.ui.toast(`Couldn't change it: ${r.deny}`)
}

/** A PR the session's transcript links to. */
export type LinkedPr = { url: string; number: number; repo: string; created: boolean }

/**
 * Notes the PR a transcript entry links to. Claude Code records them itself:
 * `{"type":"pr-link", prNumber, prUrl, prRepository}` entries, and
 * `toolUseResult.gitOperation.pr` with `action: "created"` for the PRs the
 * session created.
 */
export function linkedPrs(list: LinkedPr[], entry: any): void {
  if (!entry || typeof entry !== 'object') return
  if (entry.type === 'pr-link' && typeof entry.prUrl === 'string') {
    addLinked(list, entry.prUrl, entry.prNumber, entry.prRepository, false)
    return
  }
  const pr = entry.toolUseResult?.gitOperation?.pr
  if (typeof pr?.url === 'string') addLinked(list, pr.url, pr.number, undefined, pr.action === 'created')
}

function addLinked(list: LinkedPr[], url: string, number: unknown, repo: unknown, created: boolean): void {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  const existing = list.find(p => p.url === url)
  if (existing) {
    existing.created ||= created
    return
  }
  const n = typeof number === 'number' ? number : Number(m?.[2] ?? 0)
  const r = typeof repo === 'string' ? repo : m?.[1] ?? ''
  if (n && r) list.push({ url, number: n, repo: r, created })
}

/** Only lines with one of these can link a PR; the rest are skipped unparsed. */
const MAY_LINK = /"pr-link"|"gitOperation"/
/** The most of the transcript read in one go. */
const CHUNK = 4 * 1024 * 1024

/** How far the transcript has been read, and the PRs found so far. */
let transcript = { path: '', offset: 0, prs: [] as LinkedPr[] }

function decodeBase64(b64: string): Uint8Array {
  const from = (Uint8Array as any).fromBase64 as ((s: string) => Uint8Array) | undefined
  return from ? from(b64) : Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

/** Reads what the transcript gained since last time, whole lines only. */
async function scanTranscript($: Dollar): Promise<LinkedPr[]> {
  const { transcriptPath: path } = await $.session.info()
  if (!path) return []
  if (path !== transcript.path) transcript = { path, offset: 0, prs: [] }
  let size: number
  try {
    size = (await $.fs.stat(path)).size
  } catch {
    return transcript.prs
  }
  if (size < transcript.offset) transcript = { path, offset: 0, prs: [] }
  while (transcript.offset < size) {
    const length = Math.min(CHUNK, size - transcript.offset)
    const bytes = decodeBase64((await $.fs.read(path, { as: 'bytes', offset: transcript.offset, length })).base64)
    const end = bytes.lastIndexOf(0x0a)
    if (end < 0) {
      // A line still being written; one longer than a chunk can't link a PR worth showing.
      if (length === CHUNK) transcript.offset += length
      break
    }
    for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split('\n')) {
      if (!MAY_LINK.test(line)) continue
      try {
        linkedPrs(transcript.prs, JSON.parse(line))
      } catch {
        // a malformed line: skip it
      }
    }
    transcript.offset += end + 1
  }
  return transcript.prs
}

type PrStatus = { state: string | null; isDraft: boolean; checks: Checks | null; fetchedAt: number }
/** Each session PR's state and CI from `gh`, by `repo#number`. */
const statuses = new Map<string, PrStatus>()
const fetching = new Set<string>()
/** An open PR's state is asked for again after a minute; a merged or closed one's after 15. */
const OPEN_TTL_MS = 60_000
const DONE_TTL_MS = 15 * 60_000

function summarizeChecks(rollup: unknown): Checks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  const rows = (rollup as Array<Record<string, unknown>>).map(checkRow)
  if (rows.some(r => r.result === 'fail')) return 'fail'
  if (rows.some(r => r.result === 'pending')) return 'pending'
  return 'pass'
}

async function fetchStatus($: Dollar, pr: LinkedPr): Promise<void> {
  const key = `${pr.repo}#${pr.number}`
  if (fetching.has(key)) return
  fetching.add(key)
  try {
    const p = await gh($, ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'state,isDraft,statusCheckRollup'])
    statuses.set(key, { state: p.state ?? null, isDraft: Boolean(p.isDraft), checks: summarizeChecks(p.statusCheckRollup), fetchedAt: await $.clock.now() })
  } catch {
    // Offline or not logged in: keep what was known and try again next time.
    const old = statuses.get(key)
    statuses.set(key, { state: old?.state ?? null, isDraft: old?.isDraft ?? false, checks: old?.checks ?? null, fetchedAt: await $.clock.now() })
  } finally {
    fetching.delete(key)
  }
}

/**
 * The session's PRs: the ones its transcript links to, with their state and
 * CI from `gh`. With `hideMergedSessionPrs` on, merged PRs drop out of the band
 * and the pane.
 */
async function loadSessionPrs($: Dollar): Promise<void> {
  const linked = await scanTranscript($)
  const now = await $.clock.now()
  const stale = linked.filter(p => {
    const s = statuses.get(`${p.repo}#${p.number}`)
    const isDone = s?.state === 'MERGED' || s?.state === 'CLOSED'
    return !s || now - s.fetchedAt > (isDone ? DONE_TTL_MS : OPEN_TTL_MS)
  })
  await Promise.all(stale.map(p => fetchStatus($, p)))
  const list: SessionPr[] = []
  for (const p of linked) {
    const s = statuses.get(`${p.repo}#${p.number}`)
    if (hideMerged && s?.state === 'MERGED') continue
    list.push({ number: p.number, url: p.url, repo: p.repo, created: p.created, state: s?.state ?? null, isDraft: s?.isDraft ?? false, checks: s?.checks ?? null })
  }
  list.sort(bySessionOrder)
  const before = await read($, sessionPrs)
  if (JSON.stringify(before) !== JSON.stringify(list)) await update($, sessionPrs, () => list)
}

function emptyDetail(repo: string, number: number, title: string, url: string): Detail {
  return {
    repo, number, title, url, body: '', state: '', author: '', labels: [], assignees: [], createdAt: '',
    comments: 0, isDraft: false, branch: '', base: '', review: '', checks: [], reviews: [],
    additions: 0, deletions: 0, files: 0, mergedAt: null, mergedBy: '', closedAt: null, mergeable: '', mergeState: '',
    merge: 'idle', mergeMethods: [], canBypass: false, bypass: false,
    isLoading: true, isRefreshing: false, error: null,
  }
}

async function openPane($: Dollar, title: string): Promise<void> {
  await $.ui.open({ id: PANE, title })
  isPaneOpen = true
}

async function openPr($: Dollar, repo: string, pr: { number: number; title?: string; url: string }, keep = false): Promise<void> {
  const base = emptyDetail(repo, pr.number, pr.title ?? '', pr.url)
  if (keep) await update($, detail, d => (d ? { ...d, isRefreshing: true } : d))
  else {
    await update($, run, () => null)
    await update($, detail, () => base)
  }
  try {
    const p = await gh($, ['pr', 'view', String(pr.number), '--repo', repo, '--json',
      'number,title,url,body,state,isDraft,author,labels,assignees,createdAt,comments,headRefName,baseRefName,reviewDecision,statusCheckRollup,reviews,additions,deletions,changedFiles,mergedAt,mergedBy,closedAt,mergeable,mergeStateStatus'])
    // Latest review per reviewer.
    const latest = new Map<string, ReviewRow>()
    for (const r of p.reviews ?? []) latest.set(r.author?.login ?? '?', { author: r.author?.login ?? '?', state: r.state })
    await update($, detail, d => (d?.number !== pr.number ? d : {
      ...base,
      title: p.title,
      body: p.body ?? '',
      state: p.state,
      isDraft: Boolean(p.isDraft),
      author: p.author?.login ?? '',
      labels: (p.labels ?? []).map((l: any) => l.name),
      assignees: (p.assignees ?? []).map((a: any) => a.login),
      createdAt: p.createdAt,
      comments: Array.isArray(p.comments) ? p.comments.length : 0,
      branch: p.headRefName ?? '',
      base: p.baseRefName ?? '',
      review: p.reviewDecision ?? '',
      checks: (p.statusCheckRollup ?? []).map(checkRow),
      reviews: [...latest.values()],
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      files: p.changedFiles ?? 0,
      mergedAt: p.mergedAt || null,
      mergedBy: p.mergedBy?.login ?? '',
      closedAt: p.closedAt || null,
      mergeable: p.mergeable ?? '',
      mergeState: p.mergeStateStatus ?? '',
      isLoading: false,
    }))
  } catch (err) {
    if (keep) await refreshFailed($, err)
    else await update($, detail, d => (d?.number !== pr.number ? d : { ...base, isLoading: false, error: (err as Error).message }))
  }
}

const MERGE_METHODS: { id: MergeMethod; flag: string; label: string; hotkey: string; allowed: string }[] = [
  { id: 'squash', flag: '--squash', label: 'Squash and merge', hotkey: 's', allowed: 'squashMergeAllowed' },
  { id: 'merge', flag: '--merge', label: 'Merge commit', hotkey: 'c', allowed: 'mergeCommitAllowed' },
  { id: 'rebase', flag: '--rebase', label: 'Rebase and merge', hotkey: 'e', allowed: 'rebaseMergeAllowed' },
]

/** First press of Merge: asks which method, offering only those the repo allows. */
async function askMerge($: Dollar): Promise<void> {
  const d = await read($, detail)
  if (!d || d.merge !== 'idle') return
  await update($, detail, x => (x ? { ...x, merge: 'confirm' as const, bypass: false } : x))
  try {
    const repo = await gh($, ['repo', 'view', d.repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerPermission'])
    const methods = MERGE_METHODS.filter(m => repo[m.allowed] !== false).map(m => m.id)
    const canBypass = String(repo.viewerPermission ?? '').toUpperCase() === 'ADMIN'
    await update($, detail, x => (x?.number === d.number ? { ...x, mergeMethods: methods, canBypass } : x))
  } catch {
    await update($, detail, x => (x?.number === d.number ? { ...x, mergeMethods: MERGE_METHODS.map(m => m.id) } : x))
  }
}

/** `gh pr merge` with the method the person picked; then shows the PR as merged. */
async function mergePr($: Dollar, method: MergeMethod): Promise<void> {
  const d = await read($, detail)
  if (!d || d.merge !== 'confirm') return
  await update($, detail, x => (x ? { ...x, merge: 'sending' as const } : x))
  const flag = MERGE_METHODS.find(m => m.id === method)!.flag
  const argv = ['gh', 'pr', 'merge', String(d.number), '--repo', d.repo, flag, ...(d.canBypass && d.bypass ? ['--admin'] : [])]
  const r = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
  if (r.exitCode !== 0) {
    await update($, detail, x => (x ? { ...x, merge: 'confirm' as const } : x))
    const why = (r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`
    await $.ui.toast(`Couldn't merge #${d.number}: ${why}${d.canBypass && !d.bypass ? ' (as an admin you can turn on the bypass)' : ''}`)
    return
  }
  await $.ui.toast(`Merged #${d.number} into ${d.base || 'the base branch'}`)
  await openPr($, d.repo, d, true)
  statuses.delete(`${d.repo}#${d.number}`)
  void loadSessionPrs($)
  // The merge landed on origin's base branch: bring the main checkout's along.
  const b = await read($, base)
  if (b && b.branch === d.base && (!b.repo || b.repo.toLowerCase() === d.repo.toLowerCase())) {
    await loadBase($, true)
    await syncBase($)
  }
}

/** A refresh that fails keeps what is shown and says why. */
async function refreshFailed($: Dollar, err: unknown): Promise<void> {
  await update($, detail, d => (d ? { ...d, isRefreshing: false } : d))
  await $.ui.toast(`Couldn't refresh: ${(err as Error).message}`)
}

/** Reloads the PR on screen without blanking it. */
async function refreshDetail($: Dollar): Promise<void> {
  const d = await read($, detail)
  if (!d || d.isLoading || d.isRefreshing) return
  await openPr($, d.repo, d, true)
}

async function openRun($: Dollar, repo: string, runId: number, name: string): Promise<void> {
  const loading: RunView = {
    repo, runId, name, number: 0, attempt: 1, branch: '', event: '', status: '', result: 'pending', url: '',
    startedAt: null, updatedAt: null, jobs: [], rerun: 'idle', isLoading: true, isRefreshing: false, error: null,
  }
  await update($, run, () => loading)
  await loadRun($)
}

/** Loads the open run's jobs, then the log of each failed job (up to 3). */
async function loadRun($: Dollar): Promise<void> {
  const current = await read($, run)
  if (!current) return
  const { repo, runId } = current
  if (!current.isLoading) await update($, run, r => (r?.runId === runId ? { ...r, isRefreshing: true } : r))
  try {
    const r = await gh($, ['run', 'view', String(runId), '--repo', repo, '--json',
      'name,workflowName,status,conclusion,number,attempt,headBranch,event,startedAt,updatedAt,url,jobs'])
    let fresh: RunView | null = null
    await update($, run, prev => {
      if (prev?.runId !== runId) return prev
      const oldJobs = new Map(prev.jobs.map(j => [j.id, j]))
      const jobs = (r.jobs ?? []).map((j: any): RunJob => {
        const result = actionsResult(j.status, j.conclusion)
        const old = oldJobs.get(j.databaseId)
        // A job keeps its log while it is still the same failure.
        const keepLog = old && old.result === 'fail' && result === 'fail' && old.completedAt === (j.completedAt || null)
        return {
          id: j.databaseId,
          name: j.name,
          result,
          startedAt: j.startedAt || null,
          completedAt: j.status === 'completed' ? j.completedAt || null : null,
          failedSteps: (j.steps ?? []).filter((st: any) => FAILED.has(String(st.conclusion ?? '').toUpperCase())).map((st: any) => st.name),
          log: keepLog ? old.log : null,
          logError: keepLog ? old.logError : null,
        }
      })
      fresh = {
        ...prev,
        name: r.workflowName || r.name || prev.name,
        number: r.number ?? 0,
        attempt: r.attempt ?? 1,
        branch: r.headBranch ?? '',
        event: r.event ?? '',
        status: String(r.status ?? '').toLowerCase(),
        result: actionsResult(r.status, r.conclusion),
        url: r.url ?? '',
        startedAt: r.startedAt || null,
        updatedAt: r.updatedAt || null,
        jobs,
        isLoading: false,
        isRefreshing: false,
        error: null,
      }
      return fresh
    })
    const needLogs = ((fresh as RunView | null)?.jobs ?? []).filter(j => j.result === 'fail' && !j.log && !j.logError).slice(0, 3)
    await Promise.all(needLogs.map(j => loadJobLog($, repo, runId, j.id)))
  } catch (err) {
    const message = (err as Error).message
    await update($, run, r => (r?.runId !== runId ? r : r.isLoading ? { ...r, isLoading: false, error: message } : { ...r, isRefreshing: false }))
    if (!current.isLoading) await $.ui.toast(`Couldn't refresh the run: ${message}`)
  }
}

async function loadJobLog($: Dollar, repo: string, runId: number, jobId: number): Promise<void> {
  const r = await $.process.run(['gh', 'run', 'view', '--job', String(jobId), '--repo', repo, '--log-failed'], { cwd, timeoutMs: 60_000 })
  const log = r.exitCode === 0 ? logTail(r.stdout) : null
  const logError = r.exitCode === 0 ? (log!.length ? null : 'the log is empty') : (r.stderr || r.stdout).trim().split('\n')[0] || 'log not available'
  await update($, run, v => (v?.runId !== runId ? v : {
    ...v,
    jobs: v.jobs.map(j => (j.id === jobId ? { ...j, log: log?.length ? log : null, logError } : j)),
  }))
}

/** `gh run rerun --failed`: starts the failed jobs again. Only after the person confirmed. */
async function rerunFailed($: Dollar): Promise<void> {
  const v = await read($, run)
  if (!v || v.rerun !== 'confirm') return
  await update($, run, r => (r ? { ...r, rerun: 'sending' as const } : r))
  const r = await $.process.run(['gh', 'run', 'rerun', String(v.runId), '--failed', '--repo', v.repo], { cwd, timeoutMs: 30_000 })
  await update($, run, x => (x ? { ...x, rerun: 'idle' as const } : x))
  if (r.exitCode !== 0) {
    await $.ui.toast(`Couldn't re-run: ${(r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`}`)
    return
  }
  await $.ui.toast(`Re-running the failed jobs of ${v.name} #${v.number}`)
  await loadRun($)
}

/** Keeps what the pane shows current while CI runs. */
async function liveRefresh($: Dollar): Promise<void> {
  if (!isPaneOpen) return
  liveTick++
  const v = await read($, run)
  if (v) {
    if (!v.isLoading && !v.isRefreshing && v.status !== 'completed') await loadRun($)
    return
  }
  const d = await read($, detail)
  if (d && liveTick % 2 === 0 && d.checks.some(c => c.result === 'pending')) await refreshDetail($)
}

async function openWeb($: Dollar, argv: string[], what: string): Promise<void> {
  const r = await $.process.run(['gh', ...argv, '--web'], { cwd, timeoutMs: 15_000 })
  if (r.exitCode !== 0) await $.ui.toast(`Couldn't open ${what}: ${(r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`}`)
}

/**
 * Opens a PR in the browser through `gh pr view --web`, which knows how
 * to open a browser on every OS. A Link alone only works where the terminal
 * supports clickable links, and never from the keyboard.
 */
async function openOnGitHub($: Dollar, item: Detail): Promise<void> {
  const r = await $.process.run(['gh', 'pr', 'view', String(item.number), '--repo', item.repo, '--web'], { cwd, timeoutMs: 15_000 })
  if (r.exitCode !== 0) await $.ui.toast(`Couldn't open #${item.number}: ${(r.stderr || r.stdout).trim().split('\n')[0] || `gh exited with ${r.exitCode}`}`)
}

export const register: Register = (on, options) => {
  hideMerged = options[HIDE_MERGED_FIELD] !== false
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    transcript = { path: '', offset: 0, prs: [] }
    statuses.clear()
    await $.command.register({
      name: 'gh',
      description: "GitHub pane with this session's PRs: their CI, reviews and description, and merging them",
    })
    void loadSessionPrs($)
    void loadBase($, true)
    $.clock.every(FETCH_MS, () => loadBase($, true))
    $.clock.every(SESSION_PRS_MS, () => loadSessionPrs($))
    // Local only: catches a pull made by hand without asking origin.
    $.clock.every(SESSION_PRS_MS, () => loadBase($, false))
    $.clock.every(LIVE_MS, () => liveRefresh($))
    return next(e)
  })

  on('command.run', { command: 'gh' }, async ($, e) => {
    if (e.args.trim()) return { text: 'Usage: /gh' }
    void loadSessionPrs($)
    await update($, run, () => null)
    await update($, detail, () => null)
    await openPane($, 'Session PRs')
    return { text: 'GitHub pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      isPaneOpen = false
      await update($, run, () => null)
      await update($, detail, () => null) // redraws the band without a highlighted entry
    }
    return closed
  })

  // One line above the prompt: the base branch and this session's PRs, each one pressable.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const mine = await read($, sessionPrs)
    const b = await read($, base)
    if (!mine.length && !b) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    const shown = await read($, detail)
    // Opens the pane on the session's list; pressing it again closes it.
    const openList = async () => {
      if (isPaneOpen && !(await read($, detail))) {
        await $.ui.close({ id: PANE })
        return
      }
      await update($, run, () => null)
      await update($, detail, () => null)
      await openPane($, 'Session PRs')
    }
    // Opens a session PR straight in its detail view; pressing it again closes the pane.
    const openSessionPr = async (p: SessionPr) => {
      const open = await read($, detail)
      if (isPaneOpen && open?.number === p.number && open.repo === p.repo) {
        await $.ui.close({ id: PANE })
        return
      }
      void openPr($, p.repo, p)
      await openPane($, `PR #${p.number}`)
    }
    const isListOn = isPaneOpen && !shown
    const isPrOn = (p: SessionPr) => isPaneOpen && shown?.number === p.number && shown.repo === p.repo

    // Already in session order (open first); the band stays one line however many the session has.
    const onBand = mine.slice(0, BAND_PRS)
    const hidden = mine.length - onBand.length

    const prMark = (p: SessionPr) => {
      if (p.state === 'MERGED') return <Text color="magenta"> merged</Text>
      if (p.state === 'CLOSED') return <Text color="red"> closed</Text>
      if (p.checks === 'fail') return <Text color="red"> ✗</Text>
      if (p.checks === 'pending') return <Text color="yellow"> ⏳</Text>
      if (p.checks === 'pass') return <Text color="green"> ✓</Text>
      return p.isDraft ? <Text dimColor> draft</Text> : ''
    }

    // main ✓ up to date · ↓3 behind (press to sync) · ↑1 ahead · ✎ uncommitted changes · ⚠ fetch failed.
    const baseMark = (x: BaseView) => {
      if (x.sync === 'syncing') return <Text color="yellow"> ⟳ syncing…</Text>
      const marks: RenderChildren[] = []
      if (x.behind) marks.push(<Text key="behind" color="yellow"> ↓{x.behind} ⟳</Text>)
      if (x.ahead) marks.push(<Text key="ahead" color="cyan"> ↑{x.ahead}</Text>)
      if (x.isDirty) marks.push(<Text key="dirty" color="yellow"> ✎</Text>)
      if (x.error) marks.push(<Text key="error" color="red"> ⚠</Text>)
      return marks.length ? marks : <Text color="green"> ✓</Text>
    }

    return (
      <Box flexDirection="row" gap={1}>
        {b ? (
          <Button key="band-base" hotkey="s" onPress={() => syncBase($)}>
            <Text bold>{b.branch}</Text>
            {baseMark(b)}
          </Button>
        ) : null}
        {b && mine.length ? <Text dimColor>·</Text> : null}
        {onBand.map(p => (
          <Button key={`session-pr-${safeKey(p.repo)}-${p.number}`} onPress={() => openSessionPr(p)}>
            <Text bold={isPrOn(p)} inverse={isPrOn(p)} dimColor={!p.created && !isPrOn(p)}>#{p.number}</Text>
            {prMark(p)}
          </Button>
        ))}
        {hidden ? (
          <Button key="band-session-more" onPress={openList}>
            <Text bold={isListOn} inverse={isListOn} dimColor={!isListOn}>+{hidden}</Text>
          </Button>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const now = await $.clock.now()
    const shown = await read($, detail)
    const width = e.props.bodyColumns
    const icon = (r: CheckResult) =>
      r === 'pass' ? <Text color="green">✓</Text> : r === 'fail' ? <Text color="red">✗</Text> : r === 'pending' ? <Text color="yellow">⏳</Text> : <Text dimColor>–</Text>

    const wf = await read($, run)
    if (wf) {
      const isRunning = wf.status !== 'completed'
      const failedJobs = wf.jobs.filter(j => j.result === 'fail').length
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" gap={2}>
            <Button key="run-back" hotkey="b" onPress={() => update($, run, () => null)} label="← back" />
            <Button key="run-web" hotkey="o" onPress={() => openWeb($, ['run', 'view', String(wf.runId), '--repo', wf.repo], 'the run')} label="↗ Open on GitHub" />
            <Button key="run-refresh" hotkey="r" onPress={() => loadRun($)} label={wf.isRefreshing ? '↻ Refreshing…' : '↻ Refresh'} />
          </Box>
          <Text bold wrap="truncate-end">
            {icon(wf.result)} {wf.name}{wf.number ? <Text dimColor> · run #{wf.number}{wf.attempt > 1 ? ` · attempt ${wf.attempt}` : ''}</Text> : null}
          </Text>
          {wf.isLoading ? null : (
            <Text dimColor wrap="truncate-end">
              {wf.branch}{wf.event ? ` · ${wf.event}` : ''}
              {isRunning
                ? ` · ${wf.status === 'queued' ? 'queued' : 'running'}${wf.startedAt ? ` for ${duration(wf.startedAt, now)}` : ''} · refreshes every ${LIVE_MS / 1000}s`
                : wf.startedAt ? ` · ${duration(wf.startedAt, wf.updatedAt)}` : ''}
            </Text>
          )}
          <Text dimColor>{'─'.repeat(Math.min(60, width))}</Text>
          {wf.isLoading ? <Text dimColor>Loading…</Text>
            : wf.error ? <Text color="red">⚠ {wf.error}</Text>
            : wf.jobs.map(j => (
              <Box key={`job-${j.id}`} flexDirection="column">
                <Button key={`job-${j.id}`} plain onPress={() => openWeb($, ['run', 'view', '--job', String(j.id), '--repo', wf.repo], j.name)}>
                  {icon(j.result)}
                  <Text bold={j.result === 'fail'}> {j.name}</Text>
                  <Text dimColor>  {j.result === 'pending' ? (j.startedAt ? `running ${duration(j.startedAt, now)}` : 'queued') : duration(j.startedAt, j.completedAt)}</Text>
                </Button>
                {j.failedSteps.map(st => (
                  <Text key={`step-${j.id}-${st}`} color="red" wrap="truncate-end">   ✗ {st}</Text>
                ))}
                {j.result !== 'fail' ? null
                  : j.log ? j.log.map((l, i) => <Text key={`log-${j.id}-${i}`} dimColor wrap="truncate-end">   │ {l}</Text>)
                  : j.logError ? <Text dimColor>   log not available: {j.logError}</Text>
                  : failedJobs <= 3 ? <Text dimColor>   Loading log…</Text> : null}
              </Box>
            ))}
          {!wf.isLoading && !isRunning && failedJobs ? (
            wf.rerun === 'confirm' ? (
              <Box flexDirection="column">
                <Text color="yellow" wrap="wrap">Re-run the {failedJobs} failed job{failedJobs === 1 ? '' : 's'} of {wf.name} #{wf.number}? This starts CI again on GitHub.</Text>
                <Box flexDirection="row" gap={2}>
                  <Button key="rerun-yes" hotkey="y" onPress={() => rerunFailed($)} label="Yes, re-run" />
                  <Button key="rerun-no" hotkey="n" onPress={() => update($, run, r => (r ? { ...r, rerun: 'idle' as const } : r))} label="Cancel" />
                </Box>
              </Box>
            ) : wf.rerun === 'sending' ? (
              <Text dimColor>Requesting the re-run…</Text>
            ) : (
              <Button key="rerun" hotkey="f" onPress={() => update($, run, r => (r ? { ...r, rerun: 'confirm' as const } : r))} label={`⟲ Re-run failed job${failedJobs === 1 ? '' : 's'}`} />
            )
          ) : null}
        </Box>
      )
    }

    if (shown) {
      const reviewWord = (s: string) =>
        s === 'APPROVED' ? <Text color="green">approved</Text> : s === 'CHANGES_REQUESTED' ? <Text color="red">requested changes</Text> : <Text dimColor>{s.toLowerCase().replace('_', ' ')}</Text>
      const isOpenPr = !shown.isLoading && shown.state === 'OPEN'
      const canMerge = isOpenPr && !shown.isDraft && shown.mergeable !== 'CONFLICTING' && shown.mergeState !== 'DIRTY'
      const MERGE_STATE: Record<string, [string, string]> = {
        CLEAN: ['green', 'ready to merge'],
        HAS_HOOKS: ['green', 'ready to merge'],
        UNSTABLE: ['yellow', 'mergeable, with failing checks'],
        BLOCKED: ['yellow', 'blocked (reviews or checks missing)'],
        BEHIND: ['yellow', 'behind the base branch'],
        DIRTY: ['red', 'has conflicts'],
        DRAFT: ['gray', 'draft'],
      }
      const badge = shown.state === 'MERGED' ? (
          <Text wrap="truncate-end">
            <Text bold color="magenta">● Merged</Text>
            <Text dimColor>{shown.mergedBy ? ` by @${shown.mergedBy}` : ''}{shown.mergedAt ? ` ${ago(shown.mergedAt, now)} ago` : ''}</Text>
          </Text>
        ) : shown.state === 'CLOSED' ? (
          <Text wrap="truncate-end">
            <Text bold color="red">● Closed without merging</Text>
            <Text dimColor>{shown.closedAt ? ` ${ago(shown.closedAt, now)} ago` : ''}</Text>
          </Text>
        ) : shown.state ? (
          <Text wrap="truncate-end">
            {shown.isDraft ? <Text bold dimColor>● Draft</Text> : <Text bold color="green">● Open</Text>}
            {shown.mergeable === 'CONFLICTING'
              ? <Text color="red"> · has conflicts</Text>
              : MERGE_STATE[shown.mergeState] && !shown.isDraft
                ? <Text color={MERGE_STATE[shown.mergeState]![0] as any}> · {MERGE_STATE[shown.mergeState]![1]}</Text>
                : null}
          </Text>
        ) : null
      const { workflows, others } = groupWorkflows(shown.checks)
      const sortedOthers = [...others].sort((a, b) => ['fail', 'pending', 'pass', 'skip'].indexOf(a.result) - ['fail', 'pending', 'pass', 'skip'].indexOf(b.result))
      const jobsLabel = (w: WorkflowGroup) =>
        w.result === 'fail' ? `${w.failed} of ${w.total} job${w.total === 1 ? '' : 's'} failed`
          : w.result === 'pending' ? `${w.done}/${w.total} jobs done`
          : `${w.total} job${w.total === 1 ? '' : 's'}`
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" gap={2}>
            <Button key="back" hotkey="b" onPress={() => update($, detail, () => null)} label="← back" />
            <Button key="open-web" hotkey="o" onPress={() => openOnGitHub($, shown)} label="↗ Open on GitHub" />
            <Button key="refresh-detail" hotkey="r" onPress={() => refreshDetail($)} label={shown.isRefreshing ? '↻ Refreshing…' : '↻ Refresh'} />
            {canMerge && shown.merge === 'idle' ? <Button key="merge" hotkey="m" onPress={() => askMerge($)} label="⇥ Merge" /> : null}
          </Box>
          <Text bold wrap="wrap">
            <Text color="green">#{shown.number}</Text> {shown.title}
          </Text>
          {badge}
          {isOpenPr && !canMerge ? (
            <Text dimColor wrap="truncate-end">
              {shown.isDraft ? "Can't merge a draft: mark it ready for review first." : 'Resolve the conflicts before merging.'}
            </Text>
          ) : null}
          {canMerge && shown.merge === 'confirm' ? (
            <Box flexDirection="column">
              <Text color="yellow" wrap="wrap">
                Merge #{shown.number} into {shown.base || 'the base branch'}? This changes {shown.base || 'it'} on GitHub.
                {shown.bypass ? ' Required reviews and checks will be bypassed.' : ''}
              </Text>
              {shown.canBypass ? (
                <Box flexDirection="row" gap={1}>
                  <Button key="merge-bypass" hotkey="a" onPress={() => update($, detail, x => (x ? { ...x, bypass: !x.bypass } : x))}
                    label={`${shown.bypass ? '☑' : '☐'} Merge as admin, bypassing the rules`} />
                  {shown.mergeState === 'BLOCKED' && !shown.bypass ? <Text dimColor>blocked: this lets you merge anyway</Text> : null}
                </Box>
              ) : null}
              {shown.mergeMethods.length ? (
                <Box flexDirection="row" gap={2}>
                  {MERGE_METHODS.filter(m => shown.mergeMethods.includes(m.id)).map(m => (
                    <Button key={`merge-${m.id}`} hotkey={m.hotkey} onPress={() => mergePr($, m.id)} label={m.label} />
                  ))}
                  <Button key="merge-cancel" hotkey="n" onPress={() => update($, detail, x => (x ? { ...x, merge: 'idle' as const } : x))} label="Cancel" />
                </Box>
              ) : <Text dimColor>Checking the repo's merge methods…</Text>}
            </Box>
          ) : null}
          {shown.merge === 'sending' ? <Text dimColor>Merging…</Text> : null}
          <Text dimColor wrap="truncate-end">
            {shown.author ? `@${shown.author}` : ''}{shown.createdAt ? ` · ${ago(shown.createdAt, now)}` : ''}
            {shown.comments ? ` · ${shown.comments} comment${shown.comments === 1 ? '' : 's'}` : ''}
            {shown.assignees.length ? ` · assigned to @${shown.assignees.join(', @')}` : ''}
          </Text>
          {shown.branch ? (
            <Text dimColor wrap="truncate-end">
              {shown.branch} → {shown.base} · <Text color="green">+{shown.additions}</Text> <Text color="red">−{shown.deletions}</Text> · {shown.files} file{shown.files === 1 ? '' : 's'}
            </Text>
          ) : null}
          {shown.labels.length ? <Text color="magenta">{shown.labels.join(' · ')}</Text> : null}
          {(workflows.length || sortedOthers.length) ? (
            <Box flexDirection="column">
              <Text bold>CI{workflows.length ? <Text dimColor> · press a workflow for its jobs and logs</Text> : null}</Text>
              {workflows.map(w => (
                <Button key={`wf-${w.runId}`} plain onPress={() => openRun($, shown.repo, w.runId, w.name)}>
                  {icon(w.result)}
                  <Text> {w.name}</Text>
                  <Text dimColor>  {jobsLabel(w)}{w.startedAt ? ` · ${w.completedAt ? duration(w.startedAt, w.completedAt) : `running ${duration(w.startedAt, now)}`}` : ''}</Text>
                </Button>
              ))}
              {sortedOthers.slice(0, 6).map((c, i) => (
                <Text key={`check-${i}`} wrap="truncate-end">{icon(c.result)} {c.name}</Text>
              ))}
              {sortedOthers.length > 6 ? <Text dimColor>+{sortedOthers.length - 6} more</Text> : null}
            </Box>
          ) : null}
          {shown.reviews.length ? (
            <Text wrap="wrap">
              <Text bold>Reviews </Text>
              {shown.reviews.map((r, i) => (
                <Text key={`review-${i}`}>{i ? ' · ' : ''}@{r.author} {reviewWord(r.state)}</Text>
              ))}
            </Text>
          ) : null}
          <Text dimColor>{'─'.repeat(Math.min(60, width))}</Text>
          {shown.isLoading ? <Text dimColor>Loading…</Text>
            : shown.error ? <Text color="red">⚠ {shown.error}</Text>
            : <Markdown key={`body-${shown.number}`} text={shown.body.trim() || '_No description._'} />}
        </Box>
      )
    }

    const mine = await read($, sessionPrs)
    const rows = mine.map(p => (
      <Button key={`spr-${safeKey(p.repo)}-${p.number}`} plain onPress={() => openPr($, p.repo, p)}>
        <Text color={p.created ? 'green' : undefined} dimColor={!p.created}>#{p.number}</Text>
        {p.state === 'MERGED' ? <Text color="magenta"> merged</Text>
          : p.state === 'CLOSED' ? <Text color="red"> closed</Text>
          : p.checks === 'fail' ? <Text color="red"> ✗</Text>
          : p.checks === 'pending' ? <Text color="yellow"> ⏳</Text>
          : p.checks === 'pass' ? <Text color="green"> ✓</Text>
          : p.isDraft ? <Text dimColor> draft</Text> : ''}
        <Text dimColor> {p.repo}{p.created ? '' : ' · related'}</Text>
      </Button>
    ))

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" gap={2}>
          <Text bold>Session PRs <Text dimColor>{mine.length}</Text></Text>
          <Button key="refresh" hotkey="r" label="↻" onPress={() => loadSessionPrs($)} />
        </Box>
        <Button key="toggle-merged" hotkey="h" onPress={() => toggleHideMerged($)}>
          <Text dimColor>{hideMerged ? 'Merged PRs hidden · show them' : 'Merged PRs shown · hide them'}</Text>
        </Button>
        {rows.length ? rows : (
          <Box flexDirection="column" paddingX={1} paddingY={1}>
            <Text bold><Text color="blue">◌</Text> No PRs in this session yet</Text>
            <Text dimColor wrap="wrap">
              {hideMerged
                ? 'PRs this session creates or mentions show up here automatically. Merged ones are hidden.'
                : 'PRs this session creates or mentions show up here automatically.'}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
