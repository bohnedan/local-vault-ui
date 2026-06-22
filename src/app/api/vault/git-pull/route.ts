import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getVaultPath } from '@/lib/vault'

const execFileAsync = promisify(execFile)

type GitError = Error & { stdout?: string; stderr?: string; code?: number }

function git(cwd: string, args: string[]) {
  return execFileAsync('git', ['-C', cwd, ...args], { timeout: 30000 })
}

// Pull updates into the vault, robust to the most common reasons a bare `git pull`
// fails from a UI button (no model, just git):
//   - no remote / no upstream → clear message instead of an opaque 500
//   - DIRTY working tree       → the vault accumulates uncommitted edits (the app
//                               writes notes; Obsidian rewrites .obsidian/workspace
//                               constantly). A pull then aborts with "local changes
//                               would be overwritten". So we COMMIT local changes
//                               first — never discarding anything — then pull.
//   - divergent branches      → Git ≥2.27 refuses without a strategy; we try a
//                               fast-forward first, then fall back to a merge.
//   - merge conflicts         → abort cleanly and tell the user to resolve in git,
//                               so the vault is never left half-merged.
export async function POST() {
  const cwd = getVaultPath()
  if (!cwd) {
    return NextResponse.json({ error: 'No vault configured.' }, { status: 400 })
  }

  // Must be a git repo with a configured upstream before we attempt anything.
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return NextResponse.json(
      { error: 'This vault is not a git repository — nothing to pull.' },
      { status: 400 }
    )
  }
  try {
    await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}'])
  } catch {
    return NextResponse.json(
      { error: 'No upstream/remote configured for this branch — set one with `git branch --set-upstream-to`.' },
      { status: 400 }
    )
  }

  // 0) Commit any local changes first so a dirty tree can't block the merge. This is
  //    the usual cause of the "git 500": the vault has uncommitted edits and the
  //    incoming commits touch the same files. Committing preserves everything; the
  //    merge below reconciles. Inline identity so it works even if git user.name/
  //    email aren't configured for this repo.
  try {
    const { stdout } = await git(cwd, ['status', '--porcelain'])
    if (stdout.trim()) {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      await git(cwd, ['add', '-A']) // stage tracked + untracked so nothing is left behind
      await git(cwd, [
        '-c', 'user.name=vault-ui', '-c', 'user.email=vault-ui@local',
        'commit', '--no-verify', '-m', `vault-ui: local vault changes before sync (${stamp})`,
      ])
    }
  } catch (commitErr) {
    const e = commitErr as GitError
    return NextResponse.json(
      { error: `Couldn't commit local vault changes before syncing: ${(e.stderr || e.message || 'commit failed').trim()}` },
      { status: 500 }
    )
  }

  // 1) Fast-forward only: the clean, no-merge-commit case. Succeeds when local has
  //    no commits the remote lacks.
  try {
    const { stdout, stderr } = await git(cwd, ['pull', '--ff-only'])
    return NextResponse.json({ stdout: stdout || stderr || 'Already up to date.' })
  } catch (ffErr) {
    const e = ffErr as GitError
    const text = `${e.stdout ?? ''}\n${e.stderr ?? ''}${e.message ?? ''}`
    const diverged = /diverge|not possible to fast-forward|Need to specify how to reconcile/i.test(text)
    if (!diverged) {
      // Some other failure (auth, network, etc.) — surface it as-is.
      return NextResponse.json({ error: (e.stderr || e.message || 'git pull failed').trim() }, { status: 500 })
    }
  }

  // 2) Diverged: merge the remote in (never discards local commits). Explicit
  //    --no-rebase so it works regardless of the repo's pull.rebase config.
  try {
    const { stdout, stderr } = await git(cwd, ['pull', '--no-rebase', '--no-edit'])
    return NextResponse.json({ stdout: stdout || stderr || 'Merged remote changes.' })
  } catch (mergeErr) {
    const e = mergeErr as GitError
    const text = `${e.stdout ?? ''}\n${e.stderr ?? ''}${e.message ?? ''}`
    if (/conflict/i.test(text)) {
      // Don't leave the vault half-merged — back it out and tell the user.
      await git(cwd, ['merge', '--abort']).catch(() => {})
      return NextResponse.json(
        { error: 'Local and remote changes conflict. Resolve them manually in git (the auto-merge was aborted, your files are untouched).' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: (e.stderr || e.message || 'git pull failed').trim() }, { status: 500 })
  }
}
