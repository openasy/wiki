// Two people changing one page. Each edit starts from a revision; when someone publishes and the page has moved on
// since, their change and the one published first are merged block by block (paragraphs, headings, lists, tables), as
// a three-way merge against the revision both started from. Changes to different blocks are both kept. When both
// changed the same blocks, or ones next to each other, nothing is published: the second person sees both versions of
// those blocks and chooses. The same blocks give the history its differences.
import { diff3Merge, diffComm } from "node-diff3";
import { blocks, plainText } from "./content.ts";

export interface Conflict {
  /** The blocks as the revision both started from had them. */
  base: string[];
  /** As the person publishing now wrote them. */
  mine: string[];
  /** As the change published first has them. */
  theirs: string[];
}

export interface Merged {
  /** Every change kept; no block was changed by both. */
  clean: boolean;
  title: string;
  /** The merge, with the publishing person's version where both changed the same blocks. */
  html: string;
  /** The same, with the version published first there. */
  theirsHtml: string;
  titleConflict: { mine: string; theirs: string } | null;
  conflicts: Conflict[];
}

/** Merges `mine` and `theirs`, both changed from `base`. */
export function merge(base: { title: string; html: string }, mine: { title: string; html: string }, theirs: { title: string; html: string }): Merged {
  const titleConflict =
    mine.title !== base.title && theirs.title !== base.title && mine.title !== theirs.title ? { mine: mine.title, theirs: theirs.title } : null;
  const title = mine.title !== base.title ? mine.title : theirs.title;
  const o = blocks(base.html);
  const a = blocks(mine.html);
  const b = blocks(theirs.html);
  const outMine: string[] = [];
  const outTheirs: string[] = [];
  const conflicts: Conflict[] = [];
  for (const chunk of diff3Merge(a, o, b, { excludeFalseConflicts: true })) {
    if (chunk.ok) {
      outMine.push(...chunk.ok);
      outTheirs.push(...chunk.ok);
      continue;
    }
    const c = chunk.conflict!;
    if (c.a.join("\n") === c.b.join("\n")) {
      outMine.push(...c.a);
      outTheirs.push(...c.a);
      continue;
    }
    conflicts.push({ base: c.o, mine: c.a, theirs: c.b });
    outMine.push(...c.a);
    outTheirs.push(...c.b);
  }
  return {
    clean: !conflicts.length && !titleConflict,
    title,
    html: outMine.join("\n"),
    theirsHtml: outTheirs.join("\n"),
    titleConflict,
    conflicts,
  };
}

export interface WordPart {
  text: string;
  kind: "same" | "added" | "removed";
}

export type Change =
  | { kind: "same" | "added" | "removed"; html: string }
  /** One block changed in place: its new HTML, and its words with what was taken out and put in. */
  | { kind: "changed"; html: string; words: WordPart[] };

const tagOf = (html: string) => /^<([a-z0-9]+)/i.exec(html)?.[1] ?? "";

/** The words of two texts, with what was removed and added. */
export function wordDiff(before: string, after: string): WordPart[] {
  // Each word with the space after it, so spaces never pair up on their own.
  const split = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];
  const out: WordPart[] = [];
  const push = (text: string, kind: WordPart["kind"]) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  for (const c of diffComm(split(before), split(after))) {
    if (c.common) push(c.common.join(""), "same");
    else {
      push(c.buffer1!.join(""), "removed");
      push(c.buffer2!.join(""), "added");
    }
  }
  return out;
}

/** What changed between two versions of a page, block by block. */
export function diff(beforeHtml: string, afterHtml: string): Change[] {
  const out: Change[] = [];
  for (const c of diffComm(blocks(beforeHtml), blocks(afterHtml))) {
    if (c.common) {
      for (const html of c.common) out.push({ kind: "same", html });
      continue;
    }
    const removed = c.buffer1 ?? [];
    const added = c.buffer2 ?? [];
    // Blocks changed in place, of the same kind, pair up; the rest were taken out or put in.
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      if (tagOf(removed[i]!) === tagOf(added[i]!) && !/^<(table|ul|ol|pre)/i.test(added[i]!))
        out.push({ kind: "changed", html: added[i]!, words: wordDiff(plainText(removed[i]!), plainText(added[i]!)) });
      else out.push({ kind: "removed", html: removed[i]! }, { kind: "added", html: added[i]! });
    }
    for (const html of removed.slice(pairs)) out.push({ kind: "removed", html });
    for (const html of added.slice(pairs)) out.push({ kind: "added", html });
  }
  return out;
}
