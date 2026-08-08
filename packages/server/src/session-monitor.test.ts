/**
 * Session detection rule tests — **the pure part only** (`parseClaudeProcesses`).
 * The poll loop (SessionMonitor) and the lsof/ps execution paths depend on processes and the
 * filesystem, which puts them outside unit scope — only the pure parts are covered here.
 *
 * The fixtures are taken from **this machine's real `ps -axww -o pid=,args=` output** (only long
 * arguments were trimmed). Since the detection rules depend on Claude Code's internals, these
 * fixtures are the contract for what detection catches and what it throws away.
 */
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CLI_BASENAME,
  INFRA_SUBCOMMANDS,
  parseClaudeProcesses,
  SESSION_ID_FLAGS,
} from './session-monitor.js';

/** Joins lines into one chunk of ps output (pids are right-aligned, so they carry leading spaces) */
function ps(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const REAL_PS_LINES = {
  /** VS Code extension session — the session ID arrives via --resume */
  vscodeExtension:
    '61452 /Users/seungwon/.vscode/extensions/anthropic.claude-code-2.1.191-darwin-arm64/resources/native-binary/claude --output-format stream-json --verbose --input-format stream-json --resume 3356e1bc-a32b-42a1-a9fa-5941499f638b --permission-mode auto',
  /** Interactive session — no session ID on the command line (this is normal) */
  interactive: '  8421 /Users/seungwon/.local/bin/claude --settings {"model":"opus"}',
  /** Background job session */
  withSessionId:
    ' 9001 /Users/seungwon/.local/bin/claude --session-id 1e6a3f52-8b91-4c0d-9e2a-77b5d1c4f8a0 -p "fix it"',
  /* ── Infrastructure processes that genuinely run all the time on this machine ── */
  bgPtyHost:
    ' 5319 claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/7649efb6/spare/ea94a220.pty.sock 200 50',
  bgSpare: ' 5330 claude bg-spare --bg-spare /tmp/cc-daemon-501/7649efb6/spare/ea94a220.claim.sock',
  daemon:
    '75774 /Users/seungwon/.local/bin/claude daemon run --origin transient --spawned-by {"label":"claude"}',
  /* ── Things that are not the claude binary (they just have 'claude' in their arguments) ── */
  desktopHelper:
    '  169 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --standard-schemes=claude-media',
  desktopApp: '  128 /Applications/Claude.app/Contents/MacOS/Claude',
  nodeWithClaudeArgs:
    '47371 /Users/seungwon/.nvm/versions/node/v24.15.0/bin/node --require /Users/seungwon/Documents/Hackathon-ClaudeWhip/node_modules/tsx/dist/preflight.cjs src/index.ts',
  /** Executable is a script inside a version directory — its basename isn't claude */
  versionedBinary:
    '74299 /Users/seungwon/.local/share/claude/versions/2.1.221 --resume /Users/seungwon/.claude/projects/-Users-x/fc5b6392-3610-4370-a9fa-baf1726eb6a1.jsonl',
  /** Shell wrapper — argv[0] is zsh */
  shellWrapper: ' 3300 /bin/zsh -c claude --session-id 1e6a3f52-8b91-4c0d-9e2a-77b5d1c4f8a0',
};

describe('parseClaudeProcesses — real ps output', () => {
  it('picks out only claude CLI sessions', () => {
    const procs = parseClaudeProcesses(ps(...Object.values(REAL_PS_LINES)));
    expect(procs.map((p) => p.pid)).toEqual([61452, 8421, 9001]);
  });

  it('extracts the session ID from the command line (both --resume and --session-id)', () => {
    const procs = parseClaudeProcesses(
      ps(REAL_PS_LINES.vscodeExtension, REAL_PS_LINES.withSessionId),
    );
    expect(procs).toEqual([
      { pid: 61452, sessionId: '3356e1bc-a32b-42a1-a9fa-5941499f638b' },
      { pid: 9001, sessionId: '1e6a3f52-8b91-4c0d-9e2a-77b5d1c4f8a0' },
    ]);
  });

  it('keeps an interactive session without a session ID as a candidate (it falls through to cwd mapping)', () => {
    const procs = parseClaudeProcesses(ps(REAL_PS_LINES.interactive));
    expect(procs).toEqual([{ pid: 8421 }]);
    expect(procs[0]).not.toHaveProperty('sessionId');
  });
});

describe('parseClaudeProcesses — filtering by executable', () => {
  it('matches any path whose basename is claude', () => {
    for (const command of [
      'claude',
      '/Users/seungwon/.local/bin/claude',
      '/Users/seungwon/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude',
      '/Users/seungwon/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude',
    ]) {
      expect(parseClaudeProcesses(ps(` 100 ${command}`)), command).toEqual([{ pid: 100 }]);
    }
  });

  it('is case-sensitive — the desktop app (Claude) is not a session', () => {
    expect(parseClaudeProcesses(ps(REAL_PS_LINES.desktopApp))).toEqual([]);
    expect(parseClaudeProcesses(ps(REAL_PS_LINES.desktopHelper))).toEqual([]);
  });

  it('does not match other people\'s processes that merely have claude in their arguments', () => {
    expect(parseClaudeProcesses(ps(REAL_PS_LINES.nodeWithClaudeArgs))).toEqual([]);
    expect(parseClaudeProcesses(ps(REAL_PS_LINES.shellWrapper))).toEqual([]);
    expect(parseClaudeProcesses(ps(REAL_PS_LINES.versionedBinary))).toEqual([]);
    expect(parseClaudeProcesses(ps(' 200 pnpm --filter @claudewhip/server dev'))).toEqual([]);
  });

  it('does not match prefixes like claude-code (it must be exactly claude)', () => {
    expect(parseClaudeProcesses(ps(' 300 /usr/local/bin/claude-code --resume'))).toEqual([]);
    expect(parseClaudeProcesses(ps(' 301 /usr/local/bin/myclaude'))).toEqual([]);
  });

  it('fails on the safe side (excludes) when the executable path contains a space', () => {
    // The token splits, so argv[0] becomes '/Users/me/My' — a documented limitation
    expect(parseClaudeProcesses(ps(' 400 /Users/me/My Apps/claude --session-id x'))).toEqual([]);
  });
});

describe('parseClaudeProcesses — excluding infrastructure subcommands', () => {
  it('is not a session when argv[1] is in INFRA_SUBCOMMANDS', () => {
    for (const subcommand of INFRA_SUBCOMMANDS) {
      expect(parseClaudeProcesses(ps(` 500 claude ${subcommand} --whatever`)), subcommand).toEqual(
        [],
      );
    }
  });

  it('excludes the three infrastructure kinds that always run on this machine (bg-pty-host / bg-spare / daemon)', () => {
    expect(
      parseClaudeProcesses(ps(REAL_PS_LINES.bgPtyHost, REAL_PS_LINES.bgSpare, REAL_PS_LINES.daemon)),
    ).toEqual([]);
  });

  it('treats it as a session when a flag sits in the subcommand position', () => {
    // Observed: ClaudeCode.app has a form that passes --bg-pty-host **as a flag**.
    // argv[1] is not a name, so the exclusion rule doesn't apply.
    expect(
      parseClaudeProcesses(
        ps(
          '73601 /Users/seungwon/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/x.sock 58 60',
        ),
      ),
    ).toEqual([{ pid: 73601 }]);
  });

  it('treats a positional-argument prompt run as a normal session', () => {
    expect(parseClaudeProcesses(ps(' 600 claude "prompt"'))).toEqual([{ pid: 600 }]);
  });

  it('treats a bare claude with no arguments as a session too', () => {
    expect(parseClaudeProcesses(ps(' 601 claude'))).toEqual([{ pid: 601 }]);
  });
});

describe('parseClaudeProcesses — session ID extraction rules', () => {
  const UUID = '1E6A3F52-8B91-4C0D-9E2A-77B5D1C4F8A0';

  it('supports only the space-separated flag/value form', () => {
    for (const flag of SESSION_ID_FLAGS) {
      expect(parseClaudeProcesses(ps(` 700 claude ${flag} ${UUID.toLowerCase()}`))).toEqual([
        { pid: 700, sessionId: UUID.toLowerCase() },
      ]);
    }
  });

  it('does not recognize the `--session-id=<uuid>` (equals) form — it stays a bare candidate', () => {
    // The current implementation compares whole tokens, so the equals form isn't supported.
    // The process is still a live session, though, so it doesn't drop out of the candidate list
    // (it falls through to cwd mapping).
    const procs = parseClaudeProcesses(ps(` 701 claude --session-id=${UUID.toLowerCase()}`));
    expect(procs).toEqual([{ pid: 701 }]);
  });

  it('normalizes the UUID to lowercase', () => {
    expect(parseClaudeProcesses(ps(` 702 claude --session-id ${UUID}`))).toEqual([
      { pid: 702, sessionId: UUID.toLowerCase() },
    ]);
  });

  it('ignores the value when it is not a UUID (paths, flags, missing values)', () => {
    expect(parseClaudeProcesses(ps(' 703 claude --session-id not-a-uuid'))).toEqual([{ pid: 703 }]);
    expect(
      parseClaudeProcesses(ps(' 704 claude --resume /Users/x/.claude/projects/-Users-x/abc.jsonl')),
    ).toEqual([{ pid: 704 }]);
    expect(parseClaudeProcesses(ps(' 705 claude --resume --verbose'))).toEqual([{ pid: 705 }]);
  });

  it('ignores a flag that is the last token, since it has no value', () => {
    expect(parseClaudeProcesses(ps(' 706 claude --verbose --session-id'))).toEqual([{ pid: 706 }]);
  });

  it('uses the value of whichever flag comes first', () => {
    const other = '99999999-9999-4999-8999-999999999999';
    expect(parseClaudeProcesses(ps(` 707 claude --resume ${other} --session-id ${UUID}`))).toEqual([
      { pid: 707, sessionId: other },
    ]);
  });
});

describe('parseClaudeProcesses — input shapes', () => {
  it('silently skips empty input, blank lines, and header lines', () => {
    expect(parseClaudeProcesses('')).toEqual([]);
    expect(parseClaudeProcesses('\n\n  \n')).toEqual([]);
    expect(parseClaudeProcesses(ps('  PID ARGS', '', ' 800 claude'))).toEqual([{ pid: 800 }]);
  });

  it('ignores the alignment spaces before the pid and converts it to a number', () => {
    expect(parseClaudeProcesses(ps('    42 claude'))).toEqual([{ pid: 42 }]);
    expect(parseClaudeProcesses(ps('99999 claude'))).toEqual([{ pid: 99999 }]);
  });

  it('preserves order across multiple lines', () => {
    const procs = parseClaudeProcesses(
      ps(' 3 claude', REAL_PS_LINES.bgSpare, ' 1 claude', ' 2 claude'),
    );
    expect(procs.map((p) => p.pid)).toEqual([3, 1, 2]);
  });

  it('returns an empty array when there is not a single process', () => {
    expect(parseClaudeProcesses(ps(REAL_PS_LINES.desktopHelper, REAL_PS_LINES.daemon))).toEqual([]);
  });
});

describe('detection rule constants', () => {
  it('has an executable name of exactly claude', () => {
    expect(CLAUDE_CLI_BASENAME).toBe('claude');
  });

  it('has no session-launch forms mixed into the infrastructure subcommand list', () => {
    expect(INFRA_SUBCOMMANDS.has('bg-spare')).toBe(true);
    expect(INFRA_SUBCOMMANDS.has('bg-pty-host')).toBe(true);
    expect(INFRA_SUBCOMMANDS.has('daemon')).toBe(true);
    // Flags are not subcommands — putting one here would lose real sessions
    for (const name of INFRA_SUBCOMMANDS) expect(name.startsWith('-')).toBe(false);
  });

  it('has --session-id / --resume as the session ID flags', () => {
    expect([...SESSION_ID_FLAGS]).toEqual(['--session-id', '--resume']);
  });
});
