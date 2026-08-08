/**
 * Prompt label tests — regression protection for the CLAUDE.md pitfall ("never leave
 * truncation to CSS").
 *
 * Rule priority: (1) full path + branch → (2) folded in the middle (`~/…/name`) + branch →
 * (3) folded path only (branch dropped) → (4) truncate into the last directory.
 * The line-2 tail (`❯ claude █`) does not enter the budget, so it is **intact under any
 * budget**.
 */
import { describe, expect, it } from 'vitest';

import type { SessionInfo } from '@claudewhip/shared';
import {
  BRANCH_MAX_CHARS,
  PATH_MIN_CHARS,
  promptLabelParts,
  PROMPT_TAIL,
} from './prompt-label.js';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: '9f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8',
    cwd: '/Users/seungwon/Documents/Hackathon-ClaudeWhip',
    lastActivityAt: 0,
    status: 'idle',
    ...overrides,
  };
}

/** The number of characters line 1 actually occupies (the caller subtracts the gap separately, so it is just the sum of the piece lengths) */
function lineChars(parts: ReturnType<typeof promptLabelParts>): number {
  return parts.pathPrefix.length + parts.pathTail.length + (parts.branch?.length ?? 0);
}

describe('home directory substitution', () => {
  it('turns /Users/<name>/… into ~/…', () => {
    const parts = promptLabelParts(session({ gitBranch: 'main' }), 60);
    expect(parts).toEqual({
      pathPrefix: '~/Documents/',
      pathTail: 'Hackathon-ClaudeWhip',
      branch: 'main',
    });
  });

  it('applies the same rule to Linux homes (/home/<name>)', () => {
    const parts = promptLabelParts(session({ cwd: '/home/dev/work/api-server' }), 60);
    expect(parts.pathPrefix).toBe('~/work/');
    expect(parts.pathTail).toBe('api-server');
  });

  it('leaves just `~` when the cwd is home itself', () => {
    const parts = promptLabelParts(session({ cwd: '/Users/seungwon' }), 60);
    expect(parts).toEqual({ pathPrefix: '', pathTail: '~', branch: null });
  });

  it('keeps paths outside home as absolute paths', () => {
    const parts = promptLabelParts(session({ cwd: '/opt/work/project' }), 60);
    expect(parts.pathPrefix).toBe('/opt/work/');
    expect(parts.pathTail).toBe('project');
  });

  it('renders the root as `/`', () => {
    expect(promptLabelParts(session({ cwd: '/' }), 60)).toEqual({
      pathPrefix: '',
      pathTail: '/',
      branch: null,
    });
  });

  it('gives a one-level path no prefix', () => {
    const parts = promptLabelParts(session({ cwd: '/tmp' }), 60);
    expect(parts).toEqual({ pathPrefix: '', pathTail: 'tmp', branch: null });
  });
});

describe('shrink steps by budget', () => {
  const full = session({ gitBranch: 'main' });

  it('(1) keeps the full path + branch when the budget is generous', () => {
    const parts = promptLabelParts(full, 60);
    expect(parts.pathPrefix).toBe('~/Documents/');
    expect(parts.branch).toBe('main');
    expect(lineChars(parts)).toBeLessThanOrEqual(60);
  });

  it('(2) folds the path in the middle but keeps the branch when it does not fit', () => {
    const parts = promptLabelParts(full, 30);
    expect(parts.pathPrefix).toBe('~/…/');
    expect(parts.pathTail).toBe('Hackathon-ClaudeWhip'); // the last directory is intact
    expect(parts.branch).toBe('main');
    expect(lineChars(parts)).toBeLessThanOrEqual(30);
  });

  it('(3) drops the branch when there is even less room', () => {
    const parts = promptLabelParts(full, 24);
    expect(parts.pathPrefix).toBe('~/…/');
    expect(parts.pathTail).toBe('Hackathon-ClaudeWhip');
    expect(parts.branch).toBeNull();
    expect(lineChars(parts)).toBeLessThanOrEqual(24);
  });

  it('(4) truncates the last directory from the end when it still overflows (the front survives)', () => {
    const parts = promptLabelParts(full, 15);
    expect(parts.pathPrefix).toBe('~/…/');
    expect(parts.pathTail).toBe('Hackathon-…');
    expect(parts.pathTail.endsWith('…')).toBe(true);
    expect(parts.branch).toBeNull();
    expect(lineChars(parts)).toBeLessThanOrEqual(15);
  });

  it('folds absolute paths the same way (`/…/`)', () => {
    const parts = promptLabelParts(session({ cwd: '/opt/very/deep/tree/project' }), 12);
    expect(parts.pathPrefix).toBe('/…/');
    expect(parts.pathTail).toBe('project');
  });

  it('still grants the lower bound (PATH_MIN_CHARS) for absurdly small budgets — the label never disappears', () => {
    for (const budget of [0, 1, -5]) {
      const parts = promptLabelParts(full, budget);
      expect(parts.pathTail.length).toBeGreaterThan(0);
      expect(lineChars(parts)).toBeLessThanOrEqual(PATH_MIN_CHARS);
    }
  });

  it('never loses information as the budget widens (monotonicity)', () => {
    let previous = 0;
    for (let budget = PATH_MIN_CHARS; budget <= 60; budget += 1) {
      const chars = lineChars(promptLabelParts(full, budget));
      expect(chars).toBeLessThanOrEqual(budget);
      expect(chars).toBeGreaterThanOrEqual(previous - 4); // it only shrinks at the step that drops the branch
      previous = chars;
    }
  });
});

describe('branch', () => {
  it('is null when absent', () => {
    expect(promptLabelParts(session(), 60).branch).toBeNull();
  });

  it('is null when it is only whitespace', () => {
    expect(promptLabelParts(session({ gitBranch: '   ' }), 60).branch).toBeNull();
  });

  it('trims leading and trailing whitespace', () => {
    expect(promptLabelParts(session({ gitBranch: ' main ' }), 60).branch).toBe('main');
  });

  it('truncates from the end past BRANCH_MAX_CHARS (18 chars) so it does not push the path out', () => {
    const branch = promptLabelParts(
      session({ gitBranch: 'feature/really-long-branch-name' }),
      120,
    ).branch;
    expect(branch).toHaveLength(BRANCH_MAX_CHARS);
    expect(branch?.endsWith('…')).toBe(true);
    expect(branch?.startsWith('feature/')).toBe(true);
  });
});

describe('sessions with an empty cwd (a real case the server could not recover)', () => {
  it('substitutes the leading characters of the session id', () => {
    const parts = promptLabelParts(session({ cwd: '' }), 60);
    expect(parts).toEqual({ pathPrefix: '', pathTail: '9f3c1a2b', branch: null });
  });

  it('shows the branch alongside it when there is one', () => {
    const parts = promptLabelParts(session({ cwd: '', gitBranch: 'main' }), 60);
    expect(parts).toEqual({ pathPrefix: '', pathTail: '9f3c1a2b', branch: 'main' });
  });

  it('treats a whitespace-only cwd the same way', () => {
    expect(promptLabelParts(session({ cwd: '   ' }), 60).pathTail).toBe('9f3c1a2b');
  });

  it('uses a short session id as-is', () => {
    expect(promptLabelParts(session({ cwd: '', sessionId: 'pid-1234' }), 60).pathTail).toBe(
      'pid-1234',
    );
  });
});

describe('the line-2 tail is independent of the budget', () => {
  it('keeps the fixed tokens unchanged', () => {
    expect(PROMPT_TAIL).toEqual({ prompt: '❯', command: 'claude', cursor: '█' });
  });

  it('never lets promptLabelParts touch the tail, however small the budget', () => {
    // The tail strings never leak into the line-1 pieces (target-node.ts builds the markup)
    for (const budget of [0, 5, 12, 200]) {
      const parts = promptLabelParts(session({ cwd: '', gitBranch: 'main' }), budget);
      const line = `${parts.pathPrefix}${parts.pathTail}${parts.branch ?? ''}`;
      expect(line).not.toContain(PROMPT_TAIL.prompt);
      expect(line).not.toContain(PROMPT_TAIL.command);
      expect(line).not.toContain(PROMPT_TAIL.cursor);
    }
  });
});
