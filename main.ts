// mend: the CLI SPEC.md specifies. Node 22, the standard library alone.
// Run as `node main.ts [options] [PATCH]`. Applies AI-written edits in four
// formats (unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON tool calls)
// to a tree of text files, matching lines at three tiers, changing every file
// or none. In a trial the last lines hand over to runner.ts when
// MAKEFUN_ENV_URL is set: keep that hand-over and runner.ts as they are.

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
const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file's lines, its own line break, and whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  fin: boolean;
}
function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, fin };
}
function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
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

interface Move {
  old: string;
  nw: string;
}
interface Ctx {
  moves: Move[];
  strict: boolean;
}
type Edit = (tree: Tree) => void;

/** One line of N: text, and the index into O when it is a context line. */
interface NLine {
  text: string;
  ctx: number | null;
}

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return strip(a) === strip(b);
}

/** Positions >= from where O matches f at one tier. */
function findAtTier(o: string[], f: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= f.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!tierEq(o[k]!, f[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at/after `from`. */
function findFirstTier(
  o: string[],
  f: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = findAtTier(o, f, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Replace f[pos .. pos+o.length) with N: context lines are the file's own matched
 *  lines; at tier 2 every other line of N is re-indented from O's first line to
 *  the file's first matched line. */
function applyRep(f: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < pos; i++) out.push(f[i]!);
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const fw = leadWs(f[pos]!);
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(f[pos + e.ctx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = fw + t.slice(p.length);
    out.push(t);
  }
  for (let i = pos + o.length; i < f.length; i++) out.push(f[i]!);
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const mustExist = (tree: Tree): string => {
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree);
      const { lines, br, fin } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      const next = [...lines.slice(0, line), ...add, ...lines.slice(line)];
      tree.now.set(p, joinFile(next, br, fin));
    };
  }
  return null;
}

/** The JSON edits of a patch: one array, or JSON Lines. */
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

/** Format detection (SPEC.md section 4): the first of these that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface HunkItem {
  k: ' ' | '-' | '+';
  text: string;
  noEol: boolean;
}
interface Hunk {
  a: number;
  body: HunkItem[];
}
interface Section {
  pair: boolean;
  oldP: string | null;
  newP: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}
function freshSection(): Section {
  return {
    pair: false,
    oldP: null,
    newP: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to
 *  the first tab, surrounding spaces removed, `/dev/null` as no file, a leading
 *  `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  let inBody = false;
  let seenHunk = false;
  const closeHunk = (): void => {
    if (hunk) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.k === ' ' && last.text === '' && !last.noEol) hunk.body.pop();
        else break;
      }
      sec!.hunks.push(hunk);
      hunk = null;
    }
    inBody = false;
  };
  const closeSection = (): void => {
    closeHunk();
    if (sec) sections.push(sec);
    sec = null;
    seenHunk = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      closeSection();
      const rest = line.slice('diff --git '.length);
      const sep = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0 || rest.slice(2, sep) === '' || rest.slice(sep + 3) === '') {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sec = freshSection();
      sec.diffOld = rest.slice(2, sep);
      sec.diffNew = rest.slice(sep + 3);
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (sec && !seenHunk && !sec.pair) {
          sec.oldP = headerPath(line);
          sec.newP = headerPath(next);
          sec.pair = true;
        } else {
          closeSection();
          sec = freshSection();
          sec.oldP = headerPath(line);
          sec.newP = headerPath(next);
          sec.pair = true;
        }
        i++;
        continue;
      }
      if (sec && !seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      if (inBody) closeHunk();
      continue;
    }
    if (line.startsWith('@@')) {
      if (!sec) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      inBody = true;
      seenHunk = true;
      continue;
    }
    if (inBody) {
      if (line === '') {
        hunk!.body.push({ k: ' ', text: '', noEol: false });
        continue;
      }
      const c = line[0]!;
      if (c === ' ' || c === '-' || c === '+') {
        hunk!.body.push({ k: c, text: line.slice(1), noEol: false });
        continue;
      }
      if (c === '\\') {
        const b = hunk!.body;
        if (b.length > 0) b[b.length - 1]!.noEol = true;
        continue;
      }
      closeHunk();
      continue;
    }
    if (sec && !seenHunk) {
      if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
  }
  closeSection();
  return sections;
}

/** Apply a section's hunks in order to one file's text. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  let cur = content;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NLine[] = [];
    for (const it of h.body) {
      if (it.k === ' ') {
        o.push(it.text);
        n.push({ text: it.text, ctx: o.length - 1 });
      } else if (it.k === '-') {
        o.push(it.text);
      } else {
        n.push({ text: it.text, ctx: null });
      }
    }
    const { lines, br, fin } = splitFile(cur);
    let lastNoEol = false;
    for (let j = h.body.length - 1; j >= 0; j--) {
      const it = h.body[j]!;
      if (it.k === ' ' || it.k === '+') {
        lastNoEol = it.noEol;
        break;
      }
    }
    if (o.length > 0) {
      const found = findFirstTier(o, lines, 0, strict);
      if (!found) throw new Fail('no-match', path);
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
      const nl = applyRep(lines, best, o, n, found.tier);
      const runsToEnd = best + o.length === lines.length;
      cur = joinFile(nl, br, runsToEnd ? !lastNoEol : fin);
    } else {
      const at = Math.min(h.a + d, lines.length);
      const ins = n.map((e) => e.text);
      const nl = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      cur = joinFile(nl, br, at === lines.length ? !lastNoEol : fin);
    }
    d += n.length - o.length;
  }
  return cur;
}

function unifiedEdits(sections: Section[], ctx: Ctx): Edit[] {
  return sections.map((s) => (tree) => {
    const oldP = s.pair ? s.oldP : (s.renameOld ?? s.diffOld);
    const newP = s.pair ? s.newP : (s.renameNew ?? s.diffNew);
    const isCreate = oldP === null || s.newFile;
    const isDelete = !isCreate && (newP === null || s.delFile);
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastNoEol = false;
      for (const h of s.hunks) {
        for (const it of h.body) {
          if (it.k === '+') {
            plus.push(it.text);
            lastNoEol = it.noEol;
          }
        }
      }
      tree.now.set(np, joinFile(plus, '\n', !lastNoEol));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (op !== np) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(tree.get(op)!, s.hunks, ctx.strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      ctx.moves.push({ old: op, nw: np });
      return;
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(tree.get(op)!, s.hunks, ctx.strict, op));
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const { lines, br, fin } = splitFile(cur);
    const found = findFirstTier(oldLines, lines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const nl = applyRep(lines, found.pos[0]!, oldLines, n, found.tier);
    tree.now.set(path, joinFile(nl, br, fin));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkItem[];
}

function v4aAddEdit(path: string, flines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile(flines, '\n', true));
  };
}
function v4aDelEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
function v4aUpdEdit(path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    let cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let cursor = 0;
    for (const ch of chunks) {
      const { lines, br, fin } = splitFile(cur);
      if (ch.anchor !== null) {
        const f = findFirstTier([ch.anchor], lines, cursor, ctx.strict);
        if (!f) throw new Fail('no-match', path);
        cursor = f.pos[0]! + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const it of ch.body) {
        if (it.k === ' ') {
          o.push(it.text);
          n.push({ text: it.text, ctx: o.length - 1 });
        } else if (it.k === '-') {
          o.push(it.text);
        } else {
          n.push({ text: it.text, ctx: null });
        }
      }
      if (o.length > 0) {
        const f = findFirstTier(o, lines, cursor, ctx.strict);
        if (!f) throw new Fail('no-match', path);
        const pos = f.pos[0]!;
        if (ch.eof && pos + o.length !== lines.length) throw new Fail('no-match', path);
        const nl = applyRep(lines, pos, o, n, f.tier);
        cursor = pos + n.length;
        cur = joinFile(nl, br, fin);
      } else {
        const at = ch.eof ? lines.length : cursor;
        const ins = n.map((e) => e.text);
        const nl = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + n.length;
        cur = joinFile(nl, br, fin);
      }
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, cur);
      tree.now.set(path, null);
      ctx.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, cur);
    }
  };
}

function parseV4a(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionKind = (l: string): 'add' | 'del' | 'upd' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'del';
    if (l.startsWith('*** Update File: ')) return 'upd';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = sectionKind(line);
    if (!kind) throw new Exit2(`error: parse ${i + 1}`);
    if (kind === 'add') {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const flines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (sectionKind(l) || l.trimEnd() === '*** End Patch') break;
        if (l === '') {
          flines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          flines.push(l.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push(v4aAddEdit(p, flines));
      continue;
    }
    if (kind === 'del') {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(v4aDelEdit(p));
      continue;
    }
    const p = line.slice('*** Update File: '.length).trim();
    const updLineNo = i + 1;
    i++;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let seenChunk = false;
    const closeChunk = (): void => {
      if (cur) {
        while (cur.body.length > 0) {
          const b = cur.body[cur.body.length - 1]!;
          if (b.k === ' ' && b.text === '') cur.body.pop();
          else break;
        }
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        closeChunk();
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        seenChunk = true;
        i++;
        continue;
      }
      if (l.trimEnd() === '*** End of File') {
        if (!cur) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        closeChunk();
        i++;
        continue;
      }
      if (sectionKind(l)) break;
      if (l === '') {
        if (cur) cur.body.push({ k: ' ', text: '', noEol: false });
        i++;
        continue;
      }
      const c = l[0]!;
      if (c === ' ' || c === '-' || c === '+') {
        if (!cur) {
          if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, eof: false, body: [] };
          seenChunk = true;
        }
        cur.body.push({ k: c, text: l.slice(1), noEol: false });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLineNo}`);
    edits.push(v4aUpdEdit(p, moveTo, chunks, ctx));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

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
  const ctx: Ctx = { moves: [], strict };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, ctx);
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
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of ctx.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
