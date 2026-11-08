// A page's words: the HTML the editor sends, or Markdown and HTML from another wiki, made into HTML that is safe to
// show, and the plain text the search reads. Every body goes through sanitize() before it is stored, and again when it
// is shown, so a pasted or imported page cannot carry script, styles, frames, forms or event handlers to its readers.
import serialize from "dom-serializer";
import { parseDocument } from "htmlparser2";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import { parse } from "yaml";

export type Format = "markdown" | "html";

/** Where the wiki serves its own files; the only relative address an image may have. */
export const ATTACHMENT_PATH = /^\/api\/v1\/attachments\/[A-Za-z0-9_-]{8,40}(\/[^/?#]*)?$/;
/** A link to another page of the wiki. */
const PAGE_LINK = /^\/pages\/([A-Za-z0-9_-]{6,40})(?:[/?#].*)?$/;

const POLICY: sanitizeHtml.IOptions = {
  allowedTags: [
    "h2",
    "h3",
    "h4",
    "p",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "sub",
    "sup",
    "small",
    "code",
    "kbd",
    "pre",
    "blockquote",
    "a",
    "img",
    "figure",
    "figcaption",
    "table",
    "caption",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "dl",
    "dt",
    "dd",
    "details",
    "summary",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    img: ["src", "alt", "title", "width", "height"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    ol: ["start"],
    code: ["class"],
  },
  allowedClasses: { code: ["language-*"] },
  allowedSchemes: ["https", "http", "mailto"],
  allowedSchemesByTag: { img: ["https", "http"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // The page's own heading is its title; headings inside start one level below.
  transformTags: {
    h1: "h2",
    h5: "h4",
    h6: "h4",
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const external = /^https?:/i.test(href);
      return {
        tagName,
        attribs: {
          ...(href && { href }),
          ...(attribs.title && { title: attribs.title }),
          ...(external && { rel: "noopener noreferrer nofollow", target: "_blank" }),
        },
      };
    },
    td: (tagName, attribs) => ({ tagName, attribs: spans(attribs) }),
    th: (tagName, attribs) => ({ tagName, attribs: spans(attribs) }),
  },
  exclusiveFilter: (frame) => frame.tag === "img" && !(/^https?:\/\//i.test(frame.attribs.src ?? "") || ATTACHMENT_PATH.test(frame.attribs.src ?? "")),
};

/** colspan and rowspan of 1 say nothing; the editor writes them on every cell. */
function spans(attribs: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const k of ["colspan", "rowspan", "scope"]) if (attribs[k] && attribs[k] !== "1") out[k] = attribs[k]!;
  return out;
}

/** HTML that is safe to show: only the tags and attributes a page needs, links only to http(s), mailto and the wiki. */
export function sanitize(html: string): string {
  // The editor keeps an empty paragraph at the end to type into; it is not part of the page.
  return sanitizeHtml(html, POLICY)
    .trim()
    .replace(/(\s*<p>(\s|<br \/>)*<\/p>)+$/, "");
}

/** The body as HTML, sanitized, from what was written. */
export function toHtml(body: string, format: Format): string {
  const html = format === "markdown" ? (marked.parse(body, { async: false, gfm: true, breaks: false }) as string) : body;
  return sanitize(html);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

/** The words of sanitized HTML, for the search and excerpts. */
export function plainText(html: string): string {
  const spaced = html.replace(/<(\/?(p|h[1-6]|li|td|th|dt|dd|br|hr|pre|blockquote|figcaption|summary|tr|caption)\b)/gi, " <$1");
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** Up to `max` characters of the text, cut at a word. */
export function excerpt(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).trimEnd()}…`;
}

const foldChar = (c: string) => c.replace(/[İI]/g, "i").toLowerCase().replace(/ı/g, "i").normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Text as the search compares it: lowercase, without accents, and with Turkish dotted and dotless i alike, so "sifre"
 * finds "Şifre" and "Iptal" finds "iptal".
 */
export function fold(text: string): string {
  return foldChar(text);
}

/** The words of a search, folded, at most eight. */
export function terms(q: string): string[] {
  return [
    ...new Set(
      fold(q)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ].slice(0, 8);
}

export interface Segment {
  text: string;
  /** A word of the search. */
  hit: boolean;
}

/** Some words around the first match in the text, with the matching words marked, as plain text parts. */
export function snippet(text: string, words: string[], max = 200): Segment[] {
  // Fold character by character, keeping where each folded character came from.
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) from.push(i);
    folded += f;
    i += ch.length;
  }
  from.push(text.length);
  const hits: Array<[number, number]> = [];
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\p{L}\\p{N}]*`, "gu");
    for (const m of folded.matchAll(re)) hits.push([from[m.index]!, from[m.index + m[0].length]!]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  const first = hits[0]?.[0] ?? 0;
  let start = Math.max(0, first - 60);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  const end = Math.min(text.length, start + max);
  const out: Segment[] = [];
  let at = start;
  for (const [a, b] of hits) {
    if (a < at || a >= end) continue;
    if (a > at) out.push({ text: text.slice(at, a), hit: false });
    out.push({ text: text.slice(a, Math.min(b, end)), hit: true });
    at = Math.min(b, end);
  }
  if (at < end) out.push({ text: text.slice(at, end), hit: false });
  if (start > 0 && out[0]) out[0] = { ...out[0], text: `…${out[0].text}` };
  if (end < text.length && out.length) out[out.length - 1] = { ...out[out.length - 1]!, text: `${out[out.length - 1]!.text}…` };
  return out;
}

/** The page ids sanitized HTML links to. */
export function pageLinks(html: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href="([^"]*)"/g)) {
    const id = PAGE_LINK.exec(m[1]!)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The attachment ids sanitized HTML uses, in links and images. */
export function attachmentIds(html: string): string[] {
  return [...new Set([...html.matchAll(/(?:href|src)="\/api\/v1\/attachments\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!))];
}

/** The top-level blocks of sanitized HTML: paragraphs, headings, lists, tables, as HTML each. */
export function blocks(html: string): string[] {
  return parseDocument(html)
    .children.map((n) => serialize(n))
    .map((b) => b.trim())
    .filter(Boolean);
}

/** The headings of sanitized HTML, as text, in order: the sections people are editing in. */
export function headings(html: string): string[] {
  return [...html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g)].map((m) => plainText(m[1]!)).filter(Boolean);
}

// ---------------------------------------------------------------- Markdown

/** The little of a DOM node the rules read; turndown hands them its own parser's nodes. */
interface El {
  nodeName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  childNodes: { length: number };
  parentNode: El | null;
  firstChild: unknown;
  previousSibling: unknown;
}
const el = (n: unknown) => n as El;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
turndown.addRule("fencedLanguage", {
  filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
  replacement: (_content, node) => {
    const code = el(el(node).firstChild);
    const lang = /language-(\S+)/.exec(code.getAttribute("class") ?? "")?.[1] ?? "";
    const body = (code.textContent ?? "").replace(/\n$/, "");
    const fence = body.includes("```") ? "~~~~" : "```";
    return `\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
  },
});
// GitHub tables: a header row, then the rest; cells keep their inline Markdown on one line.
turndown.addRule("tableCell", {
  filter: ["th", "td"],
  replacement: (content) => ` ${content.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()} |`,
});
turndown.addRule("tableRow", {
  filter: "tr",
  replacement: (content, node) => {
    const row = `|${content}\n`;
    const parent = el(node).parentNode;
    const isFirst = parent && (parent.nodeName === "THEAD" || (parent.firstChild === node && !parent.previousSibling));
    if (!isFirst) return row;
    const cells = el(node).childNodes.length;
    return `${row}|${" --- |".repeat(Math.max(1, cells))}\n`;
  },
});
turndown.addRule("tableSection", { filter: ["thead", "tbody", "tfoot"], replacement: (content) => content });
turndown.addRule("table", { filter: "table", replacement: (content) => `\n\n${content.trim()}\n\n` });
turndown.addRule("caption", { filter: "caption", replacement: () => "" });

/** Sanitized HTML as Markdown (GitHub flavoured: tables and fenced code). */
export function toMarkdown(html: string): string {
  return turndown.turndown(html).trim() + "\n";
}

export interface Imported {
  title: string;
  html: string;
}

/** Reads one file from another wiki: Markdown with optional front matter, or an HTML page. */
export function importFile(name: string, content: string, format: Format): Imported {
  const base = name
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (format === "markdown") {
    let body = content.replace(/^﻿/, "");
    let title = "";
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
    if (fm) {
      try {
        const doc = parse(fm[1]!) as unknown;
        if (doc && typeof doc === "object" && !Array.isArray(doc)) {
          const t = (doc as Record<string, unknown>).title;
          if (typeof t === "string") title = t.trim();
          body = body.slice(fm[0].length);
        }
      } catch {
        // Front matter that is not YAML is left in the body for the writer to see.
      }
    }
    const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
    if (h1 && body.slice(0, h1.index).trim() === "") {
      if (!title) title = h1[1]!;
      if (h1[1] === title) body = body.slice(h1.index + h1[0].length);
    }
    return { title: (title || base || "Untitled").slice(0, 200), html: toHtml(body.trim(), "markdown") };
  }
  let body = content;
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(body);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (bodyMatch) body = bodyMatch[1]!;
  let title = titleMatch ? plainText(titleMatch[1]!) : "";
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
  if (h1) {
    if (!title) title = plainText(h1[1]!);
    if (plainText(h1[1]!) === title) body = body.slice(0, h1.index) + body.slice(h1.index + h1[0].length);
  }
  return { title: (title || base || "Untitled").slice(0, 200), html: sanitize(body) };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A page as one HTML file that opens anywhere: its sanitized body, its title escaped, and a little style. */
export function htmlDocument(title: string, html: string, meta: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1f24}pre,code{font-family:ui-monospace,monospace;font-size:13px}pre{background:#f3f4f6;padding:.6rem;border-radius:6px;overflow-x:auto}table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:.25rem .5rem;text-align:left}img{max-width:100%}blockquote{border-left:3px solid #d0d7de;margin-left:0;padding-left:.75rem;color:#57606a}.meta{color:#57606a;font-size:13px}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(meta)}</p>
${sanitize(html)}
</body>
</html>
`;
}
