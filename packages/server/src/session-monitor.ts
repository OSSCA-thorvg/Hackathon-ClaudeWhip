/**
 * Active Claude Code session detector (v2). Empirically verified on this machine.
 *
 * v1 only matched `claude --session-id <uuid>`, so it caught background jobs only. v2 in short:
 *  1) One ps pass → only processes whose **executable is the claude CLI** are candidates
 *     (Claude.app helpers, cmux hooks, and other people's processes that merely have 'claude'
 *     somewhere in their arguments — like vite/pnpm — are dropped right here)
 *  2) Infrastructure roles (bg-spare / bg-pty-host / daemon …) are excluded via argv[1]
 *  3) If the command line carries a session ID (--session-id / --resume), use it as-is
 *  4) If an ID was already assigned to that pid, **keep it** (sticky) — so character identity
 *     doesn't jitter on every poll. Synthetic IDs, though, retry promotion to a real ID
 *     every SLOW_RETRY_INTERVAL_MS (10s)
 *  5) Otherwise (interactive / VS Code extension sessions) get the cwd via lsof and map it to the
 *     project directory under ~/.claude/projects → assign the newest .jsonl not yet claimed by
 *     another session
 *  6) If even that fails, still emit the session under a synthetic `pid-<pid>` ID
 *     (a live session = a character)
 *
 * The later stages (SDK metadata enrichment → status from mtime → diff/snapshot) are the same as v1.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { EventMap, SessionInfo } from '@claudewhip/shared';

const execFileAsync = promisify(execFile);

/**
 * ── Detection rule constants (where v1's SESSION_PS_PATTERN used to live) ──────
 * All of these depend on Claude Code's internal implementation (install paths, command-line
 * format, subcommand names). **If detection breaks, check here first.**
 */

/**
 * Executable name of a session process. Case-sensitive —
 * `/Applications/Claude.app/Contents/MacOS/Claude` (the desktop app) and `Claude Helper` must
 * fail this comparison. Session executables observed in practice:
 *   `~/.local/bin/claude`, the VS Code extension's `…/resources/native-binary/claude`,
 *   and a bare `claude`
 */
export const CLAUDE_CLI_BASENAME = 'claude';

/**
 * Roles that run the claude binary but are not sessions — excluded when argv[1] is one of these.
 * bg-spare/bg-pty-host/daemon are infrastructure processes that genuinely run all the time on
 * this machine.
 * (Anything not listed here counts as a session: a positional-argument run such as
 *  `claude "prompt"` is a normal session, so we can't blanket-exclude bare arguments.)
 */
export const INFRA_SUBCOMMANDS = new Set([
  'bg-spare',
  'bg-pty-host',
  'daemon',
  'mcp',
  'doctor',
  'update',
  'install',
  'migrate-installer',
  'setup-token',
  'plugin',
]);

/** Flags that carry the session ID inline on the command line (accepted only when the next token is a UUID) */
export const SESSION_ID_FLAGS: readonly string[] = ['--session-id', '--resume'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POLL_INTERVAL_MS = 1_000;
/** If the .jsonl mtime is within this window the session is 'working', otherwise 'idle' */
export const WORKING_THRESHOLD_MS = 10_000;
/**
 * Shared interval for "expensive retries that aren't fatal when they fail". Things that must run
 * far more slowly than the poll (1s):
 *  · Re-fetching SDK metadata — so we don't re-read a multi-MB jsonl on every poll
 *  · Retrying a **failed lookup** of the transcript file (fileLookupAt below) — a session we
 *    couldn't find has no reason to sweep the whole project directory once per second, and the
 *    thing that makes finding it possible in the first place is the SDK filling in the cwd hint,
 *    so matching that cadence is the right call
 *  · Attempting to promote a synthetic ID (`pid-…`) to a real session ID
 *  · Retrying a **failed** lsof cwd lookup — the lsof timeout (3s) is longer than the poll
 *    interval (1s), so without throttling a failing pid spawns a new subprocess every poll
 * Folding all four into one constant is deliberate coupling: they all share the same reason
 * ("try again around the time the SDK fills in the hint"), so we don't split them until there's
 * a reason to tune one on its own.
 */
const SLOW_RETRY_INTERVAL_MS = 10_000;
/** If lsof hangs, the poll loop backs up — generous but finite */
const LSOF_TIMEOUT_MS = 3_000;

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');

export interface SessionMonitorEvents {
  snapshot: (payload: EventMap['session_snapshot']) => void;
  started: (payload: EventMap['session_started']) => void;
  ended: (payload: EventMap['session_ended']) => void;
}

/** One session-candidate process filtered out of ps */
export interface ClaudeProcess {
  pid: number;
  /** Session ID read straight off the command line. Without it we fall through to cwd mapping. */
  sessionId?: string;
}

/** A process whose session ID has been settled */
interface ResolvedSession {
  pid: number;
  sessionId: string;
  /** true = a `pid-<pid>` ID minted because no transcript was found — we never query the SDK for it */
  synthetic: boolean;
  /** Actual working directory obtained via lsof (when present, the primary hint for labels/file lookup) */
  cwd?: string;
}

/** cwd → directory name under ~/.claude/projects (non-alphanumerics replaced with '-'). The transform is irreversible. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** cwd → path of the project directory where that cwd's transcripts live */
function projectDirFor(cwd: string): string {
  return path.join(PROJECTS_DIR, encodeProjectDir(cwd));
}

/** Whichever of `--session-id <uuid>` / `--resume <uuid>` comes first. Ignored when the value isn't a UUID. */
function extractSessionId(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length - 1; i += 1) {
    if (!SESSION_ID_FLAGS.includes(argv[i] as string)) continue;
    const value = argv[i + 1] as string;
    if (UUID_RE.test(value)) return value.toLowerCase();
  }
  return undefined;
}

/**
 * `ps -o pid=,args=` output → session-candidate processes.
 * Whether something is claude is decided **from the executable (argv[0]) alone** — so we don't
 * catch other people's processes that happen to have 'claude' in their arguments (cmux hooks,
 * shell wrappers, our own pnpm/vite).
 * (If the executable path contains a space the token splits and the process drops out of the
 * candidate list — it fails on the safe side.)
 */
export function parseClaudeProcesses(psStdout: string): ClaudeProcess[] {
  const procs: ClaudeProcess[] = [];
  for (const line of psStdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const argv = (match[2] as string).split(/\s+/);
    if (path.basename(argv[0] as string) !== CLAUDE_CLI_BASENAME) continue;
    // Every INFRA_SUBCOMMANDS entry is a name rather than a flag, so there's no need to check for a leading `-`.
    const subcommand = argv[1];
    if (subcommand && INFRA_SUBCOMMANDS.has(subcommand)) continue;

    const sessionId = extractSessionId(argv);
    procs.push({ pid: Number(match[1]), ...(sessionId ? { sessionId } : {}) });
  }
  return procs;
}

/** The list of running claude session candidates. Never goes through a shell (no string interpolation). */
async function scanClaudeProcesses(): Promise<ClaudeProcess[]> {
  // Command lines can carry a long --settings JSON blob, so give the buffer plenty of room.
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,args='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseClaudeProcesses(stdout);
}

/**
 * pid → cwd. Resolves everything in **a single lsof call** (the pid list is passed comma-separated).
 * claude never chdirs while running, so callers cache the result for the process's lifetime →
 * zero steady-state cost. On failure/timeout only those pids stay unresolved for this poll
 * (detection carries on).
 */
export async function resolveProcessCwds(pids: readonly number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;

  let stdout = '';
  try {
    // -Fpn: machine-parsable output (p<pid> / f<fd> / n<path> lines)
    ({ stdout } = await execFileAsync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], {
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    // lsof exits 1 even when it merely failed to read some pids — whatever it did read is still
    // on stdout, so we salvage it.
    const partial = (err as { stdout?: unknown }).stdout;
    stdout = typeof partial === 'string' ? partial : '';
    if (!stdout) console.error('[monitor] lsof failed — cwds unresolved for this poll:', err);
  }

  let pid: number | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/**
 * Per-session-ID cache. It is the **sole owner of filePath** — an assignment (PidAssignment) only
 * seeds it once, and every later update/invalidation (file-deletion detection → fileLookupAt=0 →
 * re-lookup) happens here.
 * (Keeping a copy on the assignment side too would re-inject the stale path on every poll, so the
 * re-lookup would never fire.)
 */
interface CachedSession {
  /** The settled .jsonl path — once found, never looked up again for the session's lifetime */
  filePath?: string;
  /**
   * Timestamp of the last **lookup attempt** (success or failure). A negative cache for sessions
   * we couldn't find: 0 means look again on the very next poll (the file-disappeared case takes
   * this path).
   */
  fileLookupAt: number;
  sdkInfo?: { cwd?: string; gitBranch?: string; summary?: string };
  sdkFetchedAt: number;
}

/** A session ID assigned to a pid is kept for the process's lifetime (so character identity doesn't jump) */
interface PidAssignment {
  sessionId: string;
  /**
   * Assignment timestamp, filled in only for synthetic IDs (`pid-…`) — used to compute the retry
   * cadence for promotion to a real session ID.
   * `undefined` means it's a real session ID that needs no promotion (= the single source of
   * truth for whether it's synthetic).
   */
  syntheticSince?: number;
}

export class SessionMonitor {
  private readonly events: SessionMonitorEvents;
  private timer: NodeJS.Timeout | undefined;
  private readonly cache = new Map<string, CachedSession>();
  /** pid → cwd (cached for the process's lifetime). claude never chdirs. */
  private readonly pidCwd = new Map<number, string>();
  /** pid → timestamp of the last lsof **attempt**. Negative cache for failed pids (retried only every SLOW_RETRY_INTERVAL_MS) */
  private readonly pidCwdAttemptAt = new Map<number, number>();
  /** pid → assigned session ID (cached for the process's lifetime) */
  private readonly pidSession = new Map<number, PidAssignment>();
  private sessions: SessionInfo[] = [];
  private lastSignature = '';

  constructor(events: SessionMonitorEvents) {
    this.events = events;
  }

  /** The current snapshot, to be sent immediately to a newly connected WS client */
  getSnapshot(): EventMap['session_snapshot'] {
    return { sessions: this.sessions };
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    let procs: ClaudeProcess[];
    try {
      procs = await scanClaudeProcesses();
    } catch (err) {
      console.error('[monitor] ps scan failed — skipping this poll:', err);
      return;
    }

    // One poll = one timestamp. Throttle decisions and status then read the same snapshot time.
    const now = Date.now();

    const livePids = new Set(procs.map((p) => p.pid));
    for (const pid of this.pidCwd.keys()) if (!livePids.has(pid)) this.pidCwd.delete(pid);
    for (const pid of this.pidCwdAttemptAt.keys()) if (!livePids.has(pid)) this.pidCwdAttemptAt.delete(pid);
    for (const pid of this.pidSession.keys()) if (!livePids.has(pid)) this.pidSession.delete(pid);

    // The cwd is looked up exactly once per process (the missing ones are batched into one lsof).
    // Failures are not retried every poll — the lsof timeout (3s) > the poll interval (1s), so
    // without throttling a failing pid would keep piling up subprocesses.
    const unknown = procs
      .filter(
        (p) =>
          !this.pidCwd.has(p.pid) &&
          now - (this.pidCwdAttemptAt.get(p.pid) ?? 0) >= SLOW_RETRY_INTERVAL_MS,
      )
      .map((p) => p.pid);
    if (unknown.length > 0) {
      for (const pid of unknown) this.pidCwdAttemptAt.set(pid, now);
      for (const [pid, cwd] of await resolveProcessCwds(unknown)) this.pidCwd.set(pid, cwd);
    }

    const resolved = await this.resolveSessionIds(procs, now);

    const liveIds = new Set(resolved.map((r) => r.sessionId));
    for (const id of this.cache.keys()) if (!liveIds.has(id)) this.cache.delete(id);

    const sessions = (await Promise.all(resolved.map((r) => this.describe(r, now)))).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    );

    this.diff(sessions);
  }

  /**
   * Process list → session-ID assignment. One session ID is claimed by exactly one process
   * (= one character). The order *is* the rule: ① command-line ID → ② keep the existing
   * assignment → ③ cwd mapping (newest unclaimed jsonl) → ④ synthetic `pid-<pid>`.
   * ① and ② must be settled first so that ③ doesn't steal someone else's file.
   */
  private async resolveSessionIds(
    procs: readonly ClaudeProcess[],
    now: number,
  ): Promise<ResolvedSession[]> {
    const ordered = [...procs].sort((a, b) => a.pid - b.pid); // so assignments don't jitter between polls
    const claimed = new Set<string>();
    const resolved: ResolvedSession[] = [];
    const pending: ClaudeProcess[] = [];

    const push = (proc: ClaudeProcess, assignment: PidAssignment): void => {
      claimed.add(assignment.sessionId);
      this.pidSession.set(proc.pid, assignment);
      const cwd = this.pidCwd.get(proc.pid);
      resolved.push({
        pid: proc.pid,
        sessionId: assignment.sessionId,
        synthetic: assignment.syntheticSince !== undefined,
        ...(cwd ? { cwd } : {}),
      });
    };

    // ① Processes with an ID on the command line (if two share an ID, the later one gets no character)
    for (const proc of ordered) {
      if (!proc.sessionId) {
        pending.push(proc);
        continue;
      }
      if (claimed.has(proc.sessionId)) continue;
      push(proc, { sessionId: proc.sessionId });
    }

    // ② Keep already-assigned pids as they are (synthetic IDs periodically retry promotion)
    const unassigned: ClaudeProcess[] = [];
    for (const proc of pending) {
      const previous = this.pidSession.get(proc.pid);
      const stale =
        previous?.syntheticSince !== undefined &&
        now - previous.syntheticSince >= SLOW_RETRY_INTERVAL_MS;
      if (previous && !stale && !claimed.has(previous.sessionId)) push(proc, previous);
      else unassigned.push(proc);
    }

    // ③ cwd → project directory → newest unclaimed transcript
    const transcriptsByCwd = new Map<string, TranscriptFile[]>();
    for (const proc of unassigned) {
      const cwd = this.pidCwd.get(proc.pid);
      let picked: TranscriptFile | undefined;
      if (cwd) {
        let transcripts = transcriptsByCwd.get(cwd);
        if (!transcripts) {
          transcripts = await listTranscripts(cwd);
          transcriptsByCwd.set(cwd, transcripts);
        }
        // Newest first — two processes in the same cwd (observed: interactive + VS Code) end up
        // claiming different files
        picked = transcripts.find((t) => !claimed.has(t.sessionId));
      }
      // ④ A live session is a session even without a transcript yet (requirement: "as many as there are active sessions")
      const sessionId = picked?.sessionId ?? `pid-${proc.pid}`;
      push(proc, picked ? { sessionId } : { sessionId, syntheticSince: now });

      // **Seed** the cache with the path we just found (so describe doesn't look the same file up again).
      // The assignment only injects it once and does not own it — deletion detection and re-lookup
      // are the cache's job from here on.
      if (picked && !this.cache.has(sessionId)) {
        this.cache.set(sessionId, { filePath: picked.filePath, fileLookupAt: now, sdkFetchedAt: 0 });
      }
    }

    return resolved;
  }

  /** One assigned session → SessionInfo. If any stage fails we degrade to whatever we know. */
  private async describe(target: ResolvedSession, now: number): Promise<SessionInfo> {
    const { sessionId } = target;
    const entry = this.cache.get(sessionId) ?? { sdkFetchedAt: 0, fileLookupAt: 0 };
    this.cache.set(sessionId, entry);

    // SDK enrichment (throttled). Omitting dir makes the SDK sweep every project directory to find
    // the session file — since we can't invert the encoded-cwd, that's our primary source for
    // recovering the cwd. Synthetic IDs (pid-…) aren't real session IDs, so we don't query them.
    if (!target.synthetic && now - entry.sdkFetchedAt >= SLOW_RETRY_INTERVAL_MS) {
      entry.sdkFetchedAt = now;
      try {
        const info = await getSessionInfo(sessionId);
        if (info) {
          entry.sdkInfo = { cwd: info.cwd, gitBranch: info.gitBranch, summary: info.summary };
        }
      } catch (err) {
        // An SDK failure must not break detection itself — degrade gracefully
        console.error(`[monitor] getSessionInfo(${sessionId}) failed — continuing without metadata:`, err);
      }
    }

    // Failed lookups are negatively cached — so a session with no transcript (they do exist)
    // doesn't trigger a full project-directory sweep every second, we retry on the same cadence
    // as the SDK re-fetch
    if (!entry.filePath && !target.synthetic && now - entry.fileLookupAt >= SLOW_RETRY_INTERVAL_MS) {
      entry.fileLookupAt = now;
      entry.filePath = await resolveSessionFile(sessionId, entry.sdkInfo?.cwd ?? target.cwd);
    }

    let lastActivityAt = 0;
    if (entry.filePath) {
      try {
        lastActivityAt = (await fs.stat(entry.filePath)).mtimeMs;
      } catch {
        // If the file is gone, clear the negative cache so the next poll looks again right away
        entry.filePath = undefined;
        entry.fileLookupAt = 0;
      }
    }

    // cwd priority: SDK (accurate) → lsof (measured from the process) → the encoded directory name
    // the transcript sits in (last resort)
    const cwd =
      entry.sdkInfo?.cwd ??
      target.cwd ??
      (entry.filePath ? path.basename(path.dirname(entry.filePath)) : '');

    return {
      sessionId,
      cwd,
      ...(entry.sdkInfo?.gitBranch ? { gitBranch: entry.sdkInfo.gitBranch } : {}),
      ...(entry.sdkInfo?.summary ? { summary: entry.sdkInfo.summary } : {}),
      lastActivityAt,
      status: now - lastActivityAt < WORKING_THRESHOLD_MS ? 'working' : 'idle',
    };
  }

  /** Compares against the previous snapshot and reports started/ended/changed. */
  private diff(next: SessionInfo[]): void {
    const previous = this.sessions;
    const prevIds = new Set(previous.map((s) => s.sessionId));
    const nextIds = new Set(next.map((s) => s.sessionId));
    this.sessions = next;

    for (const session of next) {
      if (!prevIds.has(session.sessionId)) this.events.started({ session });
    }
    for (const session of previous) {
      if (!nextIds.has(session.sessionId)) this.events.ended({ sessionId: session.sessionId });
    }

    // lastActivityAt is left out of the signature — it changes every poll, which would republish
    // the snapshot once per second.
    const signature = next
      .map((s) => `${s.sessionId}:${s.status}:${s.cwd}:${s.gitBranch ?? ''}:${s.summary ?? ''}`)
      .join('|');
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.events.snapshot(this.getSnapshot());
    }
  }
}

interface TranscriptFile {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

/** The .jsonl files in the cwd's project directory, newest first. Empty array if there are none. */
async function listTranscripts(cwd: string): Promise<TranscriptFile[]> {
  const dir = projectDirFor(cwd);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: TranscriptFile[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const stat = await fs.stat(filePath);
          files.push({ sessionId: name.slice(0, -'.jsonl'.length), filePath, mtimeMs: stat.mtimeMs });
        } catch {
          // File vanished mid-poll — ignore
        }
      }),
  );
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Finds ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
 * The encoded-cwd is irreversible, so with a cwd hint we encode it and go straight there;
 * without one we sweep the project directories.
 * (The sweep happens at most once per session — filePath is cached afterwards.)
 */
async function resolveSessionFile(sessionId: string, cwdHint?: string): Promise<string | undefined> {
  const fileName = `${sessionId}.jsonl`;

  if (cwdHint) {
    const direct = path.join(projectDirFor(cwdHint), fileName);
    if (await exists(direct)) return direct;
  }

  let dirs: string[];
  try {
    dirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, fileName);
    if (await exists(candidate)) return candidate;
  }
  // Some sessions have a live process but no transcript (measured on this machine).
  // They're still active sessions, so we do stand a character up for them — they go out with
  // lastActivityAt 0 / idle.
  return undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
