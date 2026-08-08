/**
 * Session label string assembly — pure functions (no DOM).
 *
 * It presents a session as "the shell line that launched it". But the label has to stay
 * confined inside the session column (240px) (render/layout.ts), so instead of putting
 * everything on one line it is split across **two lines**:
 *
 *     ~/Documents/sample-workspace feat/refactor   ← line 1: path + branch (the shrinkable side)
 *                                     ❯ claude █   ← line 2: fixed tail (always fully visible)
 *
 * Color and bold are CSS's job; splitting into pieces and the **length budget** are this
 * file's. The budget's only unit is characters, though — converting px into a character
 * count and subtracting the gaps between pieces is the caller's job
 * (render/target-node.ts).
 *
 * ⚠️ Truncation cannot be left to CSS. `text-overflow: ellipsis` cuts the end, but the
 * part of line 1 that must survive is the **last directory** (the identity of that
 * session), and the part that may shrink is everything before it. So line 1 takes a
 * **character budget** derived from its width and shrinks in this priority order:
 *
 *   1. full path + branch
 *   2. path folded in the middle (`~/…/lastdirectory`) + branch
 *   3. folded path only (drop the branch — the path is the only piece that distinguishes sessions)
 *   4. if it still overflows, truncate the last directory from the end
 *
 * Line 2 (`❯ claude █`) does not enter the budget computation — 10 characters always fit
 * in the column width (212px), so it never has to shrink, and it must never be allowed to.
 */
import type { SessionInfo } from '@claudewhip/shared';

/** No matter how long the branch is, we never use more than this — pushing the path out entirely makes sessions indistinguishable */
export const BRANCH_MAX_CHARS = 18;

/**
 * The fixed tokens always appended on line 2 — the render side (the markup pieces) and
 * this file must see the same values. render/target-node.ts builds the markup from these
 * values (we do not write the strings in both places).
 */
export const PROMPT_TAIL = { prompt: '❯', command: 'claude', cursor: '█' } as const;

/** However far the path gets folded, it gets at least this much (the lower bound for absurdly small budgets) */
export const PATH_MIN_CHARS = 8;

/** Home directory prefix — the server only gives us the cwd string, so the user name is absorbed by the pattern */
const HOME_PREFIX = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

export interface PromptLabelParts {
  /** Everything up to the last directory (`~/Documents/`, or `~/…/` when folded). Empty string when there is none */
  pathPrefix: string;
  /** The last directory — the part emphasized in bold. When there is no cwd, the leading characters of the session id */
  pathTail: string;
  /** git branch. null when absent → it drops out of line 1 entirely */
  branch: string | null;
}

/** Path candidate = PromptLabelParts minus the branch (used by spreading it directly) */
type PathCandidate = Omit<PromptLabelParts, 'branch'>;

/**
 * SessionInfo + the character budget for **line 1** → label pieces.
 * - No cwd: substitute the first 8 characters of the session id (there really are sessions
 *   whose cwd the server could not recover).
 * - Paths under home: `/Users/name/x` → `~/x`.
 */
export function promptLabelParts(session: SessionInfo, maxLineChars: number): PromptLabelParts {
  const budget = Math.max(PATH_MIN_CHARS, maxLineChars);
  const rawBranch = session.gitBranch?.trim();
  const branch =
    rawBranch === undefined || rawBranch === '' ? null : truncate(rawBranch, BRANCH_MAX_CHARS);

  // Steps 1 and 2: try the path (full → folded) in order while keeping the branch
  const candidates = pathCandidates(session, budget);
  for (const path of candidates) {
    if (lineChars(path, branch) <= budget) return { ...path, branch };
  }

  // Step 3: drop the branch
  const folded = candidates[candidates.length - 1] ?? { pathPrefix: '', pathTail: '' };
  if (lineChars(folded, null) <= budget) return { ...folded, branch: null };

  // Step 4: truncate down into the last directory
  return {
    pathPrefix: folded.pathPrefix,
    pathTail: truncate(folded.pathTail, Math.max(1, budget - folded.pathPrefix.length)),
    branch: null,
  };
}

/**
 * The number of characters the pieces occupy. **The gap between pieces is not counted
 * here** — whoever converts the budget from px into characters (render/target-node.ts)
 * subtracts `LABEL_GAP_PX` from the width before passing it in. If both sides each
 * subtracted a slot, the same gap would be charged twice: the gap budget has exactly one
 * owner, the px side.
 */
function lineChars(path: PathCandidate, branch: string | null): number {
  return path.pathPrefix.length + path.pathTail.length + (branch === null ? 0 : branch.length);
}

/** Path candidates from widest to narrowest — [full, folded in the middle] (only one if they are identical) */
function pathCandidates(session: SessionInfo, budget: number): PathCandidate[] {
  const cwd = session.cwd.trim();
  if (cwd === '') {
    return [{ pathPrefix: '', pathTail: truncate(session.sessionId.slice(0, 8), budget) }];
  }

  const abbreviated = cwd.replace(HOME_PREFIX, '~');
  const segments = abbreviated.split('/').filter((s) => s !== '');
  const home = abbreviated.startsWith('~');

  // '/' itself, or nothing but '~' — no prefix, that single piece is the whole thing
  if (segments.length <= 1) return [{ pathPrefix: '', pathTail: segments[0] ?? '/' }];

  const tail = segments[segments.length - 1] ?? '';
  const head = segments.slice(0, -1).join('/');
  return [
    { pathPrefix: home ? `${head}/` : `/${head}/`, pathTail: tail },
    // Folded in the middle — only the root marker is kept
    { pathPrefix: home ? '~/…/' : '/…/', pathTail: tail },
  ];
}

/** Ellipsis cuts from the end — for directories and branches the front carries more distinguishing power */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}
