export type Checks = 'pass' | 'fail' | 'pending' | 'none'

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export type CheckResult = 'pass' | 'fail' | 'pending' | 'skip'

/** One check of a PR. GitHub Actions jobs carry their workflow and run; other apps' checks don't. */
export type CheckRow = {
  name: string
  result: CheckResult
  workflow: string
  runId: number | null
  startedAt: string | null
  completedAt: string | null
}

export type RunJob = {
  id: number
  name: string
  result: CheckResult
  startedAt: string | null
  completedAt: string | null
  /** Names of the steps that failed. */
  failedSteps: string[]
  /** Last lines of the failed log, up to the error; null until loaded. */
  log: string[] | null
  logError: string | null
}

/** A GitHub Actions workflow run opened from a PR's CI section. */
export type RunView = {
  repo: string
  runId: number
  name: string
  number: number
  attempt: number
  branch: string
  event: string
  /** gh's queued / in_progress / completed. */
  status: string
  result: CheckResult
  url: string
  startedAt: string | null
  updatedAt: string | null
  jobs: RunJob[]
  rerun: 'idle' | 'confirm' | 'sending'
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
}

export type ReviewRow = { author: string; state: string }

/** What the pane shows instead of the session's list: one PR. */
export type Detail = {
  repo: string
  number: number
  title: string
  url: string
  body: string
  state: string
  author: string
  labels: string[]
  assignees: string[]
  createdAt: string
  comments: number
  isDraft: boolean
  branch: string
  base: string
  review: string
  checks: CheckRow[]
  reviews: ReviewRow[]
  additions: number
  deletions: number
  files: number
  mergedAt: string | null
  mergedBy: string
  closedAt: string | null
  /** gh's MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeable: string
  /** gh's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeState: string
  /** Merge flow from the pane: idle, asking which method, or merging. */
  merge: 'idle' | 'confirm' | 'sending'
  /** Methods the repo allows, loaded when the merge is asked for: squash, merge, rebase. */
  mergeMethods: MergeMethod[]
  /** The viewer is an admin of the repo, so `gh pr merge --admin` can bypass its rules. */
  canBypass: boolean
  /** Merge with `--admin`, bypassing required reviews and checks. Off until the person turns it on. */
  bypass: boolean
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
}

/** A PR this session's transcript links to, with its state and CI from `gh`. */
export type SessionPr = {
  number: number
  url: string
  repo: string
  created: boolean
  state: string | null
  isDraft: boolean
  checks: Checks | null
}

/** The repo's base branch in its main checkout, against the remote. */
export type BaseView = {
  /** The base branch: origin's default (origin/HEAD), else GitHub's. */
  branch: string
  /** The main checkout: the first entry of `git worktree list`. */
  dir: string
  /** `owner/repo` of origin, when it is on GitHub. */
  repo: string | null
  /** Commits the local base branch has that origin's hasn't, and the other way round. */
  ahead: number
  behind: number
  /** Whether the main checkout has the base branch checked out. */
  isCheckedOut: boolean
  /** Tracked changes in the main checkout while it has the base branch out: a pull would be refused. */
  isDirty: boolean
  sync: 'idle' | 'syncing'
  /** Why the last fetch failed; the counts are then from before it. */
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'claude-gh': {
      /** PR the pane shows instead of the session's list; null shows the list. */
      detail: Shaped<Detail | null>
      /** PRs of this session, shown as buttons on the band. */
      sessionPrs: Shaped<SessionPr[]>
      /** Workflow run the pane shows on top of a PR's detail; null shows the PR. */
      run: Shaped<RunView | null>
      /** The base branch of the session's repo, shown first on the band; null outside a git repo. */
      base: Shaped<BaseView | null>
    }
  }
}
