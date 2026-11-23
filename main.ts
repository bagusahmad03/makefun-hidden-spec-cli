// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- section 3: a file's lines

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------- section 5: matching lines

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in F at the tier; occurrences may overlap. */
function occurrences(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > F.length) return out;
  const oN = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== oN[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function maxTier(strict: boolean): number {
  return strict ? 0 : 2;
}

function findTier(O: string[], F: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = maxTier(strict);
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(O, F, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One line of N: `text` to write, or a context line copying O's line `ctx` of the matched file lines. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Build N's replacement lines: context lines are the file's own matched lines; at tier 2 the other lines are
 * re-indented from O's first line's leading whitespace to the file's first matched line's. */
function buildNew(O: string[], N: NewLine[], matched: string[], tier: number): string[] {
  const out: string[] = [];
  const F = matched.length > 0 ? leadWs(matched[0]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (const e of N) {
    if (e.ctx !== null) {
      out.push(matched[e.ctx]!);
      continue;
    }
    let line = e.text;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) line = F + line.slice(P.length);
    out.push(line);
  }
  return out;
}

function applyAt(f: FileLines, pos: number, oLen: number, newLines: string[], finalBreak: boolean): FileLines {
  const lines = [...f.lines];
  lines.splice(pos, oLen, ...newLines);
  return { br: f.br, lines, final: finalBreak };
}

/** Split O/N out of a hunk or chunk body: ' ' lines are both, '-' lines are O only, '+' lines are N only. */
function splitBody(body: BodyLine[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: null });
    }
  }
  return { O, N };
}

// Judgment calls where SPEC.md leaves the reading to the implementer (all follow the spec's literal words):
// - a second `--- `/`+++ ` pair before a section's first hunk starts a new section: a section starts at a pair
//   "not already part of a section's header", and the first pair already is that header;
// - a lone `+++ ` line names nothing (only a `--- `/`+++ ` pair names paths) and is ignored as any other header line;
// - in SEARCH/REPLACE, a `<<<<<<< SEARCH` line inside a block's old or new lines ends the scan for its `=======` /
//   `>>>>>>> REPLACE`: the block then has none after its SEARCH line, so it is a parse error at that line;
// - in V4A, a `*** End of File` line with no chunk open is "any other line": a parse error at its line, since a
//   chunk starts only at an `@@` line or, for the first chunk, at a body line.
// ---------------------------------------------------------------- section 6: unified diffs

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  oldP: string | null;
  newP: string | null;
  namedBy: 'git' | 'rename' | 'pair';
  hasPair: boolean;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function diffPath(raw: string): string | null {
  let t = raw.split('\t')[0]!;
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let hunkLines: string[] | null = null;
  let hunkA = 0;

  const endHunk = (): void => {
    if (hunkLines === null || cur === null) return;
    while (hunkLines.length > 0 && hunkLines[hunkLines.length - 1] === '') hunkLines.pop();
    const body: BodyLine[] = hunkLines.map((l) => {
      if (l === '') return { kind: ' ', text: '' } as BodyLine;
      return { kind: l[0] as BodyKind, text: l.slice(1) } as BodyLine;
    });
    let noEol = false;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
        noEol = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
        break;
      }
    }
    cur.hunks.push({ a: hunkA, body, noEol });
    hunkLines = null;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (hunkLines !== null) {
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endHunk();
      } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        hunkLines.push(l);
        i += 1;
        continue;
      } else {
        endHunk();
      }
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: m[1]!, newP: m[2]!, namedBy: 'git', hasPair: false, newFile: false, delFile: false, hunks: [] };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = diffPath(l.slice(4));
        const newP = diffPath(next.slice(4));
        if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
          cur.oldP = oldP;
          cur.newP = newP;
          cur.namedBy = 'pair';
          cur.hasPair = true;
        } else {
          cur = { oldP, newP, namedBy: 'pair', hasPair: true, newFile: false, delFile: false, hunks: [] };
          secs.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunkA = Number(m[1]);
      hunkLines = [];
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) {
        if (cur.namedBy !== 'pair') {
          cur.oldP = l.slice('rename from '.length).trim();
          cur.namedBy = 'rename';
        }
      } else if (l.startsWith('rename to ')) {
        if (cur.namedBy !== 'pair') {
          cur.newP = l.slice('rename to '.length).trim();
          cur.namedBy = 'rename';
        }
      } else if (l.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
      }
    }
    i += 1;
  }
  endHunk();

  return secs.map((sec) => (tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    const isCreation = oldP === null || sec.newFile;
    const isDeletion = !isCreation && (newP === null || sec.delFile);
    if (isCreation) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      let seenPlus = false;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlus = k;
            seenPlus = true;
          }
        }
        if (lastPlus >= 0) noEol = h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1]!.kind === '\\';
      }
      if (!seenPlus) {
        tree.now.set(newP, '');
      } else {
        tree.now.set(newP, plus.join('\n') + (noEol ? '' : '\n'));
      }
      return;
    }
    if (isDeletion) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, after);
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  });
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length === 0) {
      let at = h.a + d;
      if (at > f.lines.length) at = f.lines.length;
      if (at < 0) at = 0;
      const newLines = buildNew(O, N, [], 0);
      const reachesEnd = at === f.lines.length;
      const finalBreak = reachesEnd ? !h.noEol : f.final;
      f = { br: f.br, lines: [...f.lines.slice(0, at), ...newLines, ...f.lines.slice(at)], final: finalBreak };
      d += N.length;
    } else {
      const found = findTier(O, f.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const matched = f.lines.slice(best, best + O.length);
      const newLines = buildNew(O, N, matched, found.tier);
      const reachesEnd = best + O.length === f.lines.length;
      const finalBreak = reachesEnd ? !h.noEol : f.final;
      f = applyAt(f, best, O.length, newLines, finalBreak);
      d += N.length - O.length;
    }
  }
  return joinFile(f);
}

// ---------------------------------------------------------------- section 7: SEARCH/REPLACE blocks

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const pl = lines[j]!;
      if (pl.trim() === '') continue;
      if (pl.trim().startsWith('```')) continue;
      path = pl.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = findTier(b.old, f.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const at = found.pos[0]!;
    const matched = f.lines.slice(at, at + b.old.length);
    const newLines = buildNew(
      b.old,
      b.nw.map((t) => ({ text: t, ctx: null })),
      matched,
      found.tier,
    );
    tree.now.set(p, joinFile({ br: f.br, lines: [...f.lines.slice(0, at), ...newLines, ...f.lines.slice(at + b.old.length)], final: f.final }));
  });
}

// ---------------------------------------------------------------- section 8: V4A patches

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  updateLine: number;
  lines: string[];
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: VSection['kind'] | null = null;
    let prefix = '';
    if (l.startsWith(V4A_ADD)) {
      kind = 'add';
      prefix = V4A_ADD;
    } else if (l.startsWith(V4A_DEL)) {
      kind = 'delete';
      prefix = V4A_DEL;
    } else if (l.startsWith(V4A_UPD)) {
      kind = 'update';
      prefix = V4A_UPD;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path: l.slice(prefix.length).trim(), moveTo: null, updateLine: i + 1, lines: [] };
    sections.push(sec);
    i += 1;
    while (i < last) {
      const s = lines[i]!;
      if (s.startsWith(V4A_ADD) || s.startsWith(V4A_DEL) || s.startsWith(V4A_UPD)) break;
      sec.lines.push(s);
      i += 1;
    }
    while (sec.lines.length > 0 && blank(sec.lines[sec.lines.length - 1]!)) sec.lines.pop();
  }

  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < sec.lines.length; k++) {
        const s = sec.lines[k]!;
        if (s.startsWith('+')) fileLines.push(s.slice(1));
        else if (blank(s)) fileLines.push('');
        else throw new Exit2(`error: parse ${sec.updateLine + 1 + k}`);
      }
      return (tree: Tree) => {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      for (let k = 0; k < sec.lines.length; k++) {
        if (!blank(sec.lines[k]!)) throw new Exit2(`error: parse ${sec.updateLine + 1 + k}`);
      }
      return (tree: Tree) => {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    // update: optional Move to first, then chunks.
    let moveTo: string | null = null;
    let j = 0;
    if (sec.lines.length > 0 && sec.lines[0]!.startsWith(V4A_MOVE)) {
      moveTo = sec.lines[0]!.slice(V4A_MOVE.length).trim();
      j = 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    let firstChunk = true;
    const closeChunk = (eof: boolean): void => {
      if (chunk === null) return;
      chunk.eof = eof;
      chunks.push(chunk);
      chunk = null;
    };
    for (; j < sec.lines.length; j++) {
      const s = sec.lines[j]!;
      const lineNo = sec.updateLine + 1 + j;
      if (s.startsWith('@@')) {
        closeChunk(false);
        chunk = { anchor: s.slice(2).trim() === '' ? null : s.slice(2).trim(), eof: false, body: [] };
        firstChunk = false;
        continue;
      }
      if (s.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${lineNo}`);
        closeChunk(true);
        firstChunk = false;
        continue;
      }
      if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
        if (chunk === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${lineNo}`);
          chunk = { anchor: null, eof: false, body: [] };
          firstChunk = false;
        }
        if (s === '') chunk.body.push({ kind: ' ', text: '' });
        else chunk.body.push({ kind: s[0] as BodyKind, text: s.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    closeChunk(false);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    return (tree: Tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const after = applyV4aChunks(before, chunks, strict, p);
      if (moveTo !== null) {
        tree.now.set(moveTo, after);
        tree.now.set(p, null);
        moves.push([p, moveTo]);
      } else {
        tree.now.set(p, after);
      }
    };
  });
}

/** Apply an Update File section's chunks in order, with the cursor starting at line 0. */
function applyV4aChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      const max = maxTier(strict);
      for (let t = 0; t <= max && foundAt < 0; t++) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (normLine(f.lines[k]!, t) === normLine(ch.anchor!, t)) {
            foundAt = k;
            break;
          }
        }
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const { O, N } = splitBody(ch.body);
    if (O.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      const newLines = buildNew(O, N, [], 0);
      f = { br: f.br, lines: [...f.lines.slice(0, at), ...newLines, ...f.lines.slice(at)], final: f.final };
      cursor = at + newLines.length;
    } else {
      let found: { tier: number; pos: number } | null = null;
      const max = maxTier(strict);
      for (let t = 0; t <= max && found === null; t++) {
        const occ = occurrences(O, f.lines, t).filter((p) => p >= cursor && (!ch.eof || p + O.length === f.lines.length));
        if (occ.length > 0) found = { tier: t, pos: occ[0]! };
      }
      if (found === null) throw new Fail('no-match', path);
      const matched = f.lines.slice(found.pos, found.pos + O.length);
      const newLines = buildNew(O, N, matched, found.tier);
      f = applyAt(f, found.pos, O.length, newLines, f.final);
      cursor = found.pos + newLines.length;
    }
  }
  return joinFile(f);
}

// ---------------------------------------------------------------- run

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rPairs = moves.filter(([o, n]) => tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null);
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) entries.push({ key: n, line: `R ${o} -> ${n}` });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
