// The wiki: spaces from the file and the pages in them, who may read, edit and manage each space, publishing with the
// history of every change, merging two people's edits, drafts, presence, links between pages, the search, reviews,
// policies and who has read them, comments, attachments, templates, import and export.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Role } from "@openasy/auth";
import { EVERYONE, type Config, type ConfigFileState, type Space } from "./config.ts";
import {
  attachmentIds,
  excerpt,
  fold,
  headings,
  htmlDocument,
  importFile,
  pageLinks,
  plainText,
  sanitize,
  snippet,
  terms,
  toHtml,
  toMarkdown,
  type Format,
  type Segment,
} from "./content.ts";
import type { Mailer } from "./mail.ts";
import { diff, merge, type Change, type Conflict } from "./merge.ts";
import { TEMPLATES } from "./templates.ts";
import { zip } from "./zip.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden-origin"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "edit-conflict"
  | "payload-too-large"
  | "unsupported-media-type"
  | "internal-error";

export class WikiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  /** More for the client, such as both versions of a conflict. */
  readonly extra?: Record<string, unknown>;
  constructor(status: number, code: ProblemCode, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Who does something: a signed-in person (with an email), an API token or the tests' admin token (without). */
export interface Actor {
  /** The same person or token every time: the email, or token:<id>. */
  key: string;
  email: string | null;
  name: string;
  /** The product role from @openasy/auth. */
  role: Role;
}

export type SpaceRole = "viewer" | "editor" | "admin";
const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, admin: 3 };
const best = (a: SpaceRole | null, b: SpaceRole | null) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);
const can = (r: SpaceRole | null, min: SpaceRole) => !!r && RANK[r] >= RANK[min];

/** The product role sets a floor in every space; groups raise it space by space. */
export function roleFloor(role: Role): SpaceRole | null {
  return role === "owner" || role === "admin" ? "admin" : role === "editor" ? "editor" : role === "viewer" ? "viewer" : null;
}

const DAY = 86_400_000;
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const NOTIFY = ["none", "followers", "everyone"] as const;
type Notify = (typeof NOTIFY)[number];
const MAX_HTML = 2 * 1024 * 1024;
const PRESENCE_MS = 30_000;

interface PageRow {
  id: string;
  space: string;
  parent_id: string | null;
  position: number;
  title: string;
  html: string;
  text: string;
  revision: number;
  owner_email: string | null;
  owner_name: string | null;
  is_policy: number;
  policy_revision: number | null;
  policy_version: number;
  policy_changed_at: string | null;
  is_template: number;
  reviewed_at: string;
  reviewed_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface RevisionRow {
  id: number;
  page_id: string;
  n: number;
  kind: "create" | "edit" | "restore" | "review" | "import" | "api";
  title: string;
  html: string;
  note: string | null;
  by_email: string | null;
  by_name: string;
  at: string;
  merged: number;
}

export interface PersonRef {
  email: string | null;
  name: string;
}

export interface Known {
  email: string;
  name: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  groups: string[];
  /** Has signed in to the wiki. */
  signedIn: boolean;
}

export interface WikiOptions {
  publicUrl: string;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
  /** The environment the file's secrets are read from, by name. */
  env?: Record<string, string | undefined>;
  /** Makes the mailer for the file's mail server; null without one. */
  mailerFor?: (mail: NonNullable<Config["mail"]>, password: string | undefined) => Mailer;
  onMailError?: (error: unknown, to: string) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const newId = () => randomBytes(9).toString("base64url");

function str(v: unknown, at: string, max: number, min = 1): string {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    throw new WikiError(422, "invalid-body", `${at} is a text of ${min} to ${max} characters.`);
  return v.trim();
}

function body(b: unknown): Record<string, unknown> {
  if (!isObj(b)) throw new WikiError(422, "invalid-body", "The body is a JSON object.");
  return b;
}

/** A file or folder name in an export: no slashes or characters other systems refuse. */
function fileName(s: string) {
  return (
    s
      .replace(/[\\/:*?"<>|\p{Cc}]+/gu, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "Untitled"
  );
}

export function createWiki(db: DatabaseSync, opts: WikiOptions) {
  const clock = opts.clock ?? Date.now;
  const now = () => new Date(clock()).toISOString();
  const env = opts.env ?? process.env;
  let config: Config | null = null;
  let configText = "";
  let mailer: Mailer | null = null;
  let directoryState: { at: string | null; people: number; error: string | null } = { at: null, people: 0, error: null };
  /** Who has a page open, and who is editing it where; in memory only. */
  const presence = new Map<string, Map<string, { name: string; email: string | null; editing: boolean; section: string | null; at: number }>>();
  const viewed = new Set<string>();
  let viewedDay = "";

  const q = <R>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as R[];
  const one = <R>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as R | undefined;
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const cfg = () => {
    if (!config) throw new WikiError(503, "internal-error", "The settings file has not been read yet.");
    return config;
  };
  const spaceOf = (key: string) => cfg().spaces.find((s) => s.key === key);

  // ---------------------------------------------------------------- People and access

  /** Everyone the wiki knows: members, people who signed in, and Identity's directory. */
  function known(): Map<string, Known> {
    const out = new Map<string, Known>();
    const put = (email: string, k: Partial<Known> & { name: string }) => {
      const e = email.toLowerCase();
      const cur = out.get(e);
      out.set(e, {
        email: e,
        name: k.name || cur?.name || e,
        role: k.role ?? cur?.role ?? "user",
        status: k.status === "disabled" || cur?.status === "disabled" ? "disabled" : (k.status ?? cur?.status ?? "active"),
        groups: [...new Set([...(cur?.groups ?? []), ...(k.groups ?? [])])],
        signedIn: !!(k.signedIn || cur?.signedIn),
      });
    };
    for (const d of q<{ email: string; name: string; status: Known["status"]; groups: string }>("SELECT email, name, status, groups FROM directory"))
      put(d.email, { name: d.name, status: d.status, groups: JSON.parse(d.groups) as string[] });
    for (const u of q<{ email: string; name: string; role: Role; status: Known["status"]; last: string | null }>(
      "SELECT email, name, role, status, last_sign_in_at AS last FROM auth_users",
    ))
      put(u.email, { name: u.name, role: u.role, status: u.status, signedIn: !!u.last });
    for (const p of q<{ email: string; name: string; groups: string }>("SELECT email, name, groups FROM people"))
      put(p.email, { name: p.name, groups: JSON.parse(p.groups) as string[], signedIn: true });
    const c = config;
    if (c) for (const [g, members] of Object.entries(c.groups)) for (const m of members) if (out.has(m)) put(m, { name: "", groups: [g] });
    return out;
  }

  function groupsOf(email: string | null): Set<string> {
    const g = new Set([EVERYONE]);
    if (!email) return g;
    const e = email.toLowerCase();
    for (const r of q<{ groups: string }>("SELECT groups FROM people WHERE email = ? UNION ALL SELECT groups FROM directory WHERE email = ?", e, e))
      for (const x of JSON.parse(r.groups) as string[]) g.add(x);
    for (const [name, members] of Object.entries(config?.groups ?? {})) if (members.includes(e)) g.add(name);
    return g;
  }

  function roleFor(role: Role, email: string | null, space: Space): SpaceRole | null {
    let r = roleFloor(role);
    if (email) {
      const g = groupsOf(email);
      const any = (list: string[]) => list.some((x) => g.has(x));
      r = best(r, any(space.admins) ? "admin" : any(space.editors) ? "editor" : any(space.readers) ? "viewer" : null);
    }
    return r;
  }
  const roleIn = (who: Actor, space: Space) => roleFor(who.role, who.email, space);

  /** The page, if `who` may read its space; else 404, so pages of other spaces are not given away. */
  function readable(who: Actor, id: string): { row: PageRow; space: Space; role: SpaceRole } {
    const row = ID.test(id) ? one<PageRow>("SELECT * FROM pages WHERE id = ?", id) : undefined;
    const space = row && spaceOf(row.space);
    const role = space && roleIn(who, space);
    if (!row || !space || !role) throw new WikiError(404, "not-found", "No such page, or not one you can read.");
    return { row, space, role };
  }
  function needs(who: Actor, id: string, min: SpaceRole) {
    const r = readable(who, id);
    if (!can(r.role, min)) throw new WikiError(403, "forbidden", `This needs the ${min} role in the space ${r.space.name}.`);
    return r;
  }
  function spaceNeeds(who: Actor, key: unknown, min: SpaceRole): Space {
    const space = typeof key === "string" ? spaceOf(key) : undefined;
    const role = space && roleIn(who, space);
    if (!space || !role) throw new WikiError(404, "not-found", "No such space, or not one you can read.");
    if (!can(role, min)) throw new WikiError(403, "forbidden", `This needs the ${min} role in the space ${space.name}.`);
    return space;
  }

  function readersOf(space: Space): Known[] {
    return [...known().values()].filter((p) => p.status !== "disabled" && roleFor(p.role, p.email, space));
  }

  // ---------------------------------------------------------------- Pages, shared helpers

  const ancestors = (row: PageRow) => {
    const out: Array<{ id: string; title: string }> = [];
    let parent = row.parent_id;
    for (let i = 0; parent && i < 50; i++) {
      const p = one<{ id: string; title: string; parent_id: string | null }>("SELECT id, title, parent_id FROM pages WHERE id = ?", parent);
      if (!p) break;
      out.unshift({ id: p.id, title: p.title });
      parent = p.parent_id;
    }
    return out;
  };

  function reviewOf(row: PageRow, space: Space) {
    if (space.reviewDays === null) return { everyDays: null, reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by, due: null, overdueDays: null };
    const due = Date.parse(row.reviewed_at) + space.reviewDays * DAY;
    const overdue = Math.floor((clock() - due) / DAY);
    return {
      everyDays: space.reviewDays,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
      due: new Date(due).toISOString(),
      overdueDays: overdue >= 0 ? overdue : null,
    };
  }

  const views30 = (id: string) =>
    (one<{ n: number }>(
      "SELECT COALESCE(SUM(n), 0) AS n FROM views WHERE page_id = ? AND day >= ?",
      id,
      new Date(clock() - 30 * DAY).toISOString().slice(0, 10),
    )?.n ?? 0) as number;

  function ownerGone(row: PageRow, people: Map<string, Known>): boolean {
    if (!row.owner_email) return true;
    const p = people.get(row.owner_email);
    if (p?.status === "disabled") return true;
    // With Identity's directory, someone no longer in it has left.
    if (config?.identity && directoryState.at && !one("SELECT 1 FROM directory WHERE email = ?", row.owner_email)) return true;
    return !p;
  }

  function index(row: { id: string; title: string; text: string }) {
    run("DELETE FROM search_index WHERE page_id = ?", row.id);
    run("INSERT INTO search_index (page_id, title, body) VALUES (?, ?, ?)", row.id, fold(row.title), fold(row.text));
  }

  function relink(id: string, html: string) {
    run("DELETE FROM links WHERE from_id = ?", id);
    for (const to of pageLinks(html)) if (to !== id) run("INSERT OR IGNORE INTO links (from_id, to_id) VALUES (?, ?)", id, to);
  }

  const by = (who: Actor) => who.name;

  function follow(id: string, who: Actor) {
    if (who.email) run("INSERT OR IGNORE INTO follows (page_id, email, name) VALUES (?, ?, ?)", id, who.email, who.name);
  }

  function addRevision(
    row: { id: string; title: string; html: string },
    n: number,
    kind: RevisionRow["kind"],
    who: Actor,
    note: string | null,
    merged = false,
  ) {
    run(
      "INSERT INTO revisions (page_id, n, kind, title, html, note, by_email, by_name, at, merged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      n,
      kind,
      row.title,
      kind === "review" ? "" : row.html,
      note,
      who.email,
      by(who),
      now(),
      merged ? 1 : 0,
    );
  }

  const change = (r: RevisionRow) => ({
    n: r.n,
    kind: r.kind,
    note: r.note,
    by: { email: r.by_email, name: r.by_name },
    at: r.at,
    merged: !!r.merged,
  });

  function presenceOf(id: string, except?: string) {
    const m = presence.get(id);
    if (!m) return [];
    const t = clock();
    for (const [k, v] of m) if (t - v.at > PRESENCE_MS) m.delete(k);
    return [...m.entries()]
      .filter(([k]) => k !== except)
      .map(([, v]) => ({ name: v.name, email: v.email, editing: v.editing, section: v.section, at: new Date(v.at).toISOString() }));
  }

  function policyOf(row: PageRow, space: Space, who: Actor | null) {
    if (!row.is_policy) return null;
    const due = row.policy_changed_at ? new Date(Date.parse(row.policy_changed_at) + cfg().policies.readWithinDays * DAY).toISOString() : null;
    const mine = who?.email
      ? one<{ at: string }>("SELECT at FROM acknowledgements WHERE page_id = ? AND version = ? AND email = ?", row.id, row.policy_version, who.email)
      : undefined;
    const readers = readersOf(space);
    const emails = new Set(readers.map((r) => r.email));
    const read = q<{ email: string }>("SELECT email FROM acknowledgements WHERE page_id = ? AND version = ?", row.id, row.policy_version).filter((a) =>
      emails.has(a.email),
    ).length;
    return {
      version: row.policy_version,
      revision: row.policy_revision ?? row.revision,
      changedAt: row.policy_changed_at,
      due,
      readers: readers.length,
      read,
      readByMe: mine?.at ?? null,
    };
  }

  const summaryRow = (row: PageRow, space: Space) => ({
    id: row.id,
    title: row.title,
    space: { key: space.key, name: space.name },
    parent: row.parent_id,
    excerpt: excerpt(row.text),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });

  function detail(who: Actor, id: string) {
    const { row, space, role } = readable(who, id);
    const people = known();
    const owner = row.owner_email ? { email: row.owner_email, name: people.get(row.owner_email)?.name ?? row.owner_name ?? row.owner_email } : null;
    const children = q<{ id: string; title: string }>("SELECT id, title FROM pages WHERE parent_id = ? ORDER BY position, title", row.id);
    const backlinks = q<{ id: string; title: string; space: string }>(
      "SELECT p.id, p.title, p.space FROM links l JOIN pages p ON p.id = l.from_id WHERE l.to_id = ? ORDER BY p.title",
      row.id,
    ).filter((b) => {
      const s = spaceOf(b.space);
      return s && roleIn(who, s);
    });
    const changes = q<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? ORDER BY id DESC LIMIT 6", row.id).map(change);
    const draft = one<{ base: number; saved_at: string }>("SELECT base, saved_at FROM drafts WHERE page_id = ? AND who = ?", row.id, who.key);
    return {
      id: row.id,
      space: { key: space.key, name: space.name, readers: space.readers, editors: space.editors, admins: space.admins },
      parent: row.parent_id,
      ancestors: ancestors(row),
      title: row.title,
      // Sanitized when it was written; again here, so a page stored by an older version is held to today's rules.
      html: sanitize(row.html),
      revision: row.revision,
      owner,
      ownerGone: ownerGone(row, people),
      review: reviewOf(row, space),
      policy: policyOf(row, space, who),
      isTemplate: !!row.is_template,
      children,
      backlinks: backlinks.map((b) => ({ id: b.id, title: b.title })),
      changes,
      sections: headings(row.html),
      attachments: (one<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE page_id = ?", row.id)?.n ?? 0) as number,
      comments: (one<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE page_id = ? AND resolved_at IS NULL", row.id)?.n ?? 0) as number,
      following: !!(who.email && one("SELECT 1 FROM follows WHERE page_id = ? AND email = ?", row.id, who.email)),
      presence: presenceOf(row.id, who.key),
      draft: draft ? { base: draft.base, savedAt: draft.saved_at } : null,
      views: views30(row.id),
      role,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  function countView(who: Actor, id: string) {
    const day = now().slice(0, 10);
    if (day !== viewedDay) ((viewedDay = day), viewed.clear());
    const key = `${who.key}\n${id}`;
    if (viewed.has(key)) return;
    viewed.add(key);
    run("INSERT INTO views (page_id, day, n) VALUES (?, ?, 1) ON CONFLICT (page_id, day) DO UPDATE SET n = n + 1", id, day);
  }

  function isDescendant(candidate: string, of: string): boolean {
    let cur: string | null = candidate;
    for (let i = 0; cur && i < 200; i++) {
      if (cur === of) return true;
      cur = one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id = ?", cur)?.parent_id ?? null;
    }
    return false;
  }

  function parentIn(who: Actor, parent: unknown, space: Space): string | null {
    if (parent === undefined || parent === null || parent === "") return null;
    if (typeof parent !== "string") throw new WikiError(422, "invalid-body", "parent is a page id or null.");
    const p = readable(who, parent).row;
    if (p.space !== space.key) throw new WikiError(422, "invalid-body", "The parent page is in another space.");
    return p.id;
  }

  const nextPosition = (space: string, parent: string | null) =>
    ((one<{ n: number | null }>("SELECT MAX(position) AS n FROM pages WHERE space = ? AND parent_id IS ?", space, parent)?.n ?? -1) as number) + 1;

  function insertPage(
    who: Actor,
    space: Space,
    parent: string | null,
    title: string,
    html: string,
    kind: RevisionRow["kind"],
    extra: { policy?: boolean; template?: boolean } = {},
  ) {
    const id = newId();
    const t = now();
    const clean = sanitize(html);
    const row = { id, title, html: clean, text: plainText(clean) };
    run(
      `INSERT INTO pages (id, space, parent_id, position, title, html, text, revision, owner_email, owner_name, is_policy, policy_revision, policy_version,
        policy_changed_at, is_template, reviewed_at, reviewed_by, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      space.key,
      parent,
      nextPosition(space.key, parent),
      title,
      clean,
      row.text,
      who.email,
      who.email ? who.name : null,
      extra.policy ? 1 : 0,
      extra.policy ? 1 : null,
      extra.policy ? 1 : 0,
      extra.policy ? t : null,
      extra.template ? 1 : 0,
      t,
      who.name,
      t,
      who.name,
      t,
      who.name,
    );
    addRevision(row, 1, kind, who, null);
    index(row);
    relink(id, clean);
    follow(id, who);
    return id;
  }

  // ---------------------------------------------------------------- Mail

  function sendAll(to: Array<{ email: string; name: string }>, subject: string, text: (name: string) => string): number {
    if (!mailer) return 0;
    const m = mailer;
    for (const p of to) void m.send({ to: p.email, subject, text: text(p.name) }).catch((err: unknown) => opts.onMailError?.(err, p.email));
    return to.length;
  }
  const pageUrl = (id: string) => `${opts.publicUrl}/pages/${id}`;

  // ---------------------------------------------------------------- Publishing

  function publish(who: Actor, id: string, raw: unknown) {
    const b = body(raw);
    const { row, space, role } = needs(who, id, "editor");
    if (!Number.isInteger(b.baseRevision)) throw new WikiError(422, "invalid-body", "baseRevision is the revision the change started from.");
    const base = b.baseRevision as number;
    if (base < 1 || base > row.revision) throw new WikiError(422, "invalid-body", `baseRevision is from 1 to ${row.revision}.`);
    const title = b.title === undefined ? row.title : str(b.title, "title", 200);
    if (b.html !== undefined && b.markdown !== undefined) throw new WikiError(422, "invalid-body", "Send html or markdown, not both.");
    const source = b.markdown !== undefined ? b.markdown : b.html;
    if (source !== undefined && (typeof source !== "string" || source.length > MAX_HTML))
      throw new WikiError(422, "invalid-body", "html is a text of up to 2 MiB.");
    const html = source === undefined ? row.html : toHtml(source as string, b.markdown !== undefined ? "markdown" : "html");
    const note = b.note === undefined || b.note === null || b.note === "" ? null : str(b.note, "note", 200);
    const notify = (b.notify ?? "followers") as Notify;
    if (!NOTIFY.includes(notify)) throw new WikiError(422, "invalid-body", `notify is ${NOTIFY.join(", ")}.`);
    const kind: RevisionRow["kind"] = b.kind === "restore" ? "restore" : who.email ? "edit" : "api";

    let finalTitle = title;
    let finalHtml = html;
    let merged = false;
    if (base !== row.revision) {
      const start = one<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? AND n = ? AND kind != 'review' ORDER BY id DESC LIMIT 1", id, base);
      if (!start) throw new WikiError(422, "invalid-body", `There is no revision ${base} to merge from.`);
      const m = merge({ title: start.title, html: start.html }, { title, html }, { title: row.title, html: row.html });
      if (!m.clean) {
        const last = one<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? AND kind != 'review' ORDER BY id DESC LIMIT 1", id)!;
        throw new WikiError(
          409,
          "edit-conflict",
          `${last.by_name} changed the same part of the page while you were writing. Choose which version to keep, then publish again.`,
          {
            revision: row.revision,
            by: { email: last.by_email, name: last.by_name },
            at: last.at,
            titleConflict: m.titleConflict,
            conflicts: m.conflicts satisfies Conflict[],
            mine: { title: m.titleConflict ? title : m.title, html: sanitize(m.html) },
            theirs: { title: m.titleConflict ? row.title : m.title, html: sanitize(m.theirsHtml) },
          },
        );
      }
      finalTitle = m.title;
      finalHtml = sanitize(m.html);
      merged = true;
    }

    if (finalTitle === row.title && finalHtml === row.html) {
      run("DELETE FROM drafts WHERE page_id = ? AND who = ?", id, who.key);
      return { page: detail(who, id), merged, changed: false, told: 0 };
    }
    const n = row.revision + 1;
    const t = now();
    // A policy changed for its readers asks everyone again; a small fix ("tell nobody") keeps the version they read.
    const newVersion = !!row.is_policy && notify !== "none";
    const text = plainText(finalHtml);
    tx(() => {
      run(
        `UPDATE pages SET title = ?, html = ?, text = ?, revision = ?, updated_at = ?, updated_by = ?,
          policy_version = policy_version + ?, policy_revision = CASE WHEN ? THEN ? ELSE policy_revision END,
          policy_changed_at = CASE WHEN ? THEN ? ELSE policy_changed_at END WHERE id = ?`,
        finalTitle,
        finalHtml,
        text,
        n,
        t,
        who.name,
        newVersion ? 1 : 0,
        newVersion ? 1 : 0,
        n,
        newVersion ? 1 : 0,
        t,
        id,
      );
      addRevision({ id, title: finalTitle, html: finalHtml }, n, kind, who, note, merged);
      index({ id, title: finalTitle, text });
      relink(id, finalHtml);
      run("DELETE FROM drafts WHERE page_id = ? AND who = ?", id, who.key);
      follow(id, who);
    });
    void role;
    let told = 0;
    if (notify !== "none") {
      const to =
        notify === "everyone"
          ? readersOf(space).map((p) => ({ email: p.email, name: p.name }))
          : q<{ email: string; name: string }>("SELECT email, name FROM follows WHERE page_id = ?", id).filter((f) => {
              const p = known().get(f.email);
              return !p || p.status !== "disabled";
            });
      told = sendAll(
        to.filter((p) => p.email !== who.email),
        newVersion ? `Please read the new version of ${finalTitle}` : `${finalTitle} changed`,
        (name) =>
          [
            `Hello ${name},`,
            "",
            `${who.name} changed ${finalTitle}${note ? `: ${note}` : "."}`,
            newVersion ? "It is a policy: open it and confirm at the end of the page that you have read it." : "",
            "",
            pageUrl(id),
          ]
            .filter((l, i, a) => l !== "" || a[i - 1] !== "")
            .join("\n"),
      );
    }
    return { page: detail(who, id), merged, changed: true, told };
  }

  // ---------------------------------------------------------------- Export

  function pagePaths(space: Space) {
    const rows = q<PageRow>("SELECT * FROM pages WHERE space = ? ORDER BY position, title", space.key);
    const paths = new Map<string, string>();
    const used = new Set<string>();
    const walk = (parent: string | null, dir: string) => {
      for (const r of rows.filter((x) => x.parent_id === parent)) {
        let name = fileName(r.title);
        for (let i = 2; used.has(`${dir}${name}`.toLowerCase()); i++) name = `${fileName(r.title)} ${i}`;
        used.add(`${dir}${name}`.toLowerCase());
        paths.set(r.id, `${dir}${name}`);
        walk(r.id, `${dir}${name}/`);
      }
    };
    walk(null, "");
    return { rows, paths };
  }

  function markdownFor(row: PageRow, html: string) {
    return `# ${row.title.replace(/\n/g, " ")}\n\n${toMarkdown(html)}`;
  }

  // ---------------------------------------------------------------- The API's operations

  return {
    setConfig(next: Config, text: string): string[] {
      config = next;
      configText = text;
      mailer?.close();
      mailer = null;
      const warnings: string[] = [];
      if (next.mail) {
        const password = env[next.mail.password];
        if (next.mail.user && !password) warnings.push(`mail.password names ${next.mail.password}, which is not set: mail is sent without signing in.`);
        mailer = opts.mailerFor ? opts.mailerFor(next.mail, password) : null;
      }
      if (next.identity && !env[next.identity.token])
        warnings.push(`identity.token names ${next.identity.token}, which is not set: Identity's directory is not read.`);
      const keys = new Set(next.spaces.map((s) => s.key));
      for (const r of q<{ space: string; n: number }>("SELECT space, COUNT(*) AS n FROM pages GROUP BY space"))
        if (!keys.has(r.space)) warnings.push(`The space ${r.space} has ${r.n} pages but is not in the file; nobody sees them until it is put back.`);
      return warnings;
    },
    config: () => config,
    hasMail: () => !!mailer,
    identityToken: () => (config?.identity ? env[config.identity.token] : undefined),

    settings() {
      return {
        config,
        yaml: configText,
        file: opts.fileState?.() ?? null,
        mail: !!mailer,
        directory: config?.identity ? { url: config.identity.url, ...directoryState } : null,
      };
    },

    /** The groups someone's identity provider sent at sign-in. */
    rememberPerson(userId: string, email: string, name: string, groups: string[]) {
      run(
        "INSERT INTO people (email, user_id, name, groups, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, groups = excluded.groups, seen_at = excluded.seen_at",
        email.toLowerCase(),
        userId,
        name,
        JSON.stringify(groups),
        now(),
      );
    },

    /** Identity's directory, as read now; replaces what was read before. */
    setDirectory(people: Array<{ id: string; email: string; name: string; status: string; groups: string[] }>) {
      tx(() => {
        run("DELETE FROM directory");
        for (const p of people)
          run(
            "INSERT OR REPLACE INTO directory (email, id, name, status, groups, synced_at) VALUES (?, ?, ?, ?, ?, ?)",
            p.email.toLowerCase(),
            p.id,
            p.name,
            p.status,
            JSON.stringify(p.groups),
            now(),
          );
      });
      directoryState = { at: now(), people: people.length, error: null };
    },
    directoryFailed(error: string) {
      directoryState = { ...directoryState, error };
    },

    /** The members, for choosing an owner. */
    team() {
      return [...known().values()]
        .filter((p) => p.status !== "disabled")
        .map((p) => ({ email: p.email, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    me(who: Actor) {
      const c = cfg();
      return {
        name: who.name,
        email: who.email,
        groups: [...groupsOf(who.email)].sort(),
        spaces: c.spaces.map((s) => ({ key: s.key, role: roleIn(who, s) })).filter((s) => s.role),
      };
    },

    summary(who: Actor) {
      const c = cfg();
      const visible = c.spaces.filter((s) => roleIn(who, s));
      let pages = 0;
      let toReview = 0;
      let policiesToRead = 0;
      for (const s of visible) {
        for (const r of q<PageRow>("SELECT * FROM pages WHERE space = ?", s.key)) {
          pages++;
          if (reviewOf(r, s).overdueDays !== null) toReview++;
          if (
            r.is_policy &&
            who.email &&
            !one("SELECT 1 FROM acknowledgements WHERE page_id = ? AND version = ? AND email = ?", r.id, r.policy_version, who.email)
          )
            policiesToRead++;
        }
      }
      return { name: c.name, file: opts.fileState?.() ?? null, spaces: visible.length, pages, toReview, policiesToRead, mail: !!mailer };
    },

    gauges() {
      const c = config;
      const counts = q<{ space: string; n: number; policies: number }>("SELECT space, COUNT(*) AS n, SUM(is_policy) AS policies FROM pages GROUP BY space");
      let stale = 0;
      for (const s of c?.spaces ?? [])
        for (const r of q<PageRow>("SELECT * FROM pages WHERE space = ?", s.key)) if (reviewOf(r, s).overdueDays !== null) stale++;
      return {
        spaces: c?.spaces.length ?? 0,
        pages: counts.reduce((n, r) => n + r.n, 0),
        policies: counts.reduce((n, r) => n + (r.policies ?? 0), 0),
        stale,
      };
    },

    // ---------------------------------------------------------------- Spaces

    spaces(who: Actor) {
      return cfg()
        .spaces.map((s) => ({ s, role: roleIn(who, s) }))
        .filter((x) => x.role)
        .map(({ s, role }) => {
          const rows = q<PageRow>("SELECT * FROM pages WHERE space = ?", s.key);
          return {
            key: s.key,
            name: s.name,
            description: s.description,
            reviewDays: s.reviewDays,
            readers: s.readers,
            editors: s.editors,
            admins: s.admins,
            role,
            pages: rows.length,
            toReview: rows.filter((r) => reviewOf(r, s).overdueDays !== null).length,
          };
        });
    },

    tree(who: Actor, key: string) {
      const space = spaceNeeds(who, key, "viewer");
      return {
        space: space.key,
        pages: q<PageRow>("SELECT * FROM pages WHERE space = ? ORDER BY position, title", space.key).map((r) => ({
          id: r.id,
          title: r.title,
          parent: r.parent_id,
          position: r.position,
          stale: reviewOf(r, space).overdueDays !== null,
          policy: !!r.is_policy,
          template: !!r.is_template,
        })),
      };
    },

    /** Pages the person may read, by title, for links and the search window. */
    find(who: Actor, text: string) {
      const words = terms(text);
      const spaces = new Map(
        cfg()
          .spaces.filter((s) => roleIn(who, s))
          .map((s) => [s.key, s]),
      );
      const out: Array<{ id: string; title: string; space: { key: string; name: string }; path: string[] }> = [];
      // The latest changed first, across the spaces the person can read.
      for (const r of q<PageRow>("SELECT * FROM pages ORDER BY updated_at DESC")) {
        const s = spaces.get(r.space);
        if (!s || (words.length && !words.every((w) => fold(r.title).includes(w)))) continue;
        out.push({ id: r.id, title: r.title, space: { key: s.key, name: s.name }, path: ancestors(r).map((a) => a.title) });
        if (out.length >= 50) break;
      }
      return out;
    },

    // ---------------------------------------------------------------- Pages

    create(who: Actor, raw: unknown) {
      const b = body(raw);
      const space = spaceNeeds(who, b.space, "editor");
      const parent = parentIn(who, b.parent, space);
      const title = str(b.title, "title", 200);
      let html = "";
      if (b.template !== undefined && b.template !== null) {
        if (typeof b.template !== "string") throw new WikiError(422, "invalid-body", "template is a template's id.");
        const builtIn = TEMPLATES.find((t) => t.id === b.template);
        if (builtIn) html = builtIn.html;
        else if (b.template.startsWith("page:")) {
          const t = readable(who, b.template.slice(5)).row;
          if (!t.is_template) throw new WikiError(422, "invalid-body", "That page is not a template.");
          html = t.html;
        } else throw new WikiError(422, "invalid-body", "No such template.");
      }
      if (b.html !== undefined && b.markdown !== undefined) throw new WikiError(422, "invalid-body", "Send html or markdown, not both.");
      const source = b.markdown ?? b.html;
      if (source !== undefined) {
        if (typeof source !== "string" || source.length > MAX_HTML) throw new WikiError(422, "invalid-body", "html is a text of up to 2 MiB.");
        html = toHtml(source, b.markdown !== undefined ? "markdown" : "html");
      }
      const policy = b.policy === true;
      if (policy && !can(roleIn(who, space), "admin")) throw new WikiError(403, "forbidden", `Only admins of ${space.name} mark pages as policies.`);
      const id = tx(() => insertPage(who, space, parent, title, html, "create", { policy, template: b.template === undefined && b.isTemplate === true }));
      return detail(who, id);
    },

    get(who: Actor, id: string, opts: { count?: boolean } = {}) {
      const d = detail(who, id);
      if (opts.count !== false) countView(who, id);
      return d;
    },

    publish,

    update(who: Actor, id: string, raw: unknown) {
      const b = body(raw);
      const { row, space, role } = needs(who, id, "editor");
      const allowed = ["owner", "policy", "template", "parent", "position", "space"];
      const extra = Object.keys(b).filter((k) => !allowed.includes(k));
      if (extra.length)
        throw new WikiError(422, "invalid-body", `Unknown ${extra.join(", ")}; content changes are published with POST /api/v1/pages/{id}/publish.`);
      tx(() => {
        if (b.owner !== undefined) {
          const isOwner = !!who.email && who.email === row.owner_email;
          if (!can(role, "admin") && !isOwner && row.owner_email && !ownerGone(row, known()))
            throw new WikiError(403, "forbidden", "Only the owner or an admin of the space gives a page to someone else.");
          if (b.owner === null) run("UPDATE pages SET owner_email = NULL, owner_name = NULL WHERE id = ?", id);
          else {
            const p = typeof b.owner === "string" ? known().get(b.owner.toLowerCase()) : undefined;
            if (!p || p.status === "disabled" || !roleFor(p.role, p.email, space))
              throw new WikiError(422, "invalid-body", "owner is the email of a member who can read the space.");
            run("UPDATE pages SET owner_email = ?, owner_name = ? WHERE id = ?", p.email, p.name, id);
          }
        }
        if (b.policy !== undefined) {
          if (typeof b.policy !== "boolean") throw new WikiError(422, "invalid-body", "policy is true or false.");
          if (!can(role, "admin")) throw new WikiError(403, "forbidden", `Only admins of ${space.name} mark pages as policies.`);
          if (b.policy && !row.is_policy)
            run(
              "UPDATE pages SET is_policy = 1, policy_version = policy_version + 1, policy_revision = revision, policy_changed_at = ? WHERE id = ?",
              now(),
              id,
            );
          if (!b.policy) run("UPDATE pages SET is_policy = 0 WHERE id = ?", id);
        }
        if (b.template !== undefined) {
          if (typeof b.template !== "boolean") throw new WikiError(422, "invalid-body", "template is true or false.");
          run("UPDATE pages SET is_template = ? WHERE id = ?", b.template ? 1 : 0, id);
        }
        if (b.parent !== undefined || b.position !== undefined || b.space !== undefined) {
          const target = b.space === undefined ? space : spaceNeeds(who, b.space, "editor");
          const parent = b.parent === undefined ? (target.key === row.space ? row.parent_id : null) : parentIn(who, b.parent, target);
          if (parent && isDescendant(parent, id)) throw new WikiError(422, "invalid-body", "A page cannot go under itself or one of its own pages.");
          const position =
            b.position === undefined ? (parent === row.parent_id && target.key === row.space ? row.position : nextPosition(target.key, parent)) : b.position;
          if (!Number.isInteger(position) || (position as number) < 0) throw new WikiError(422, "invalid-body", "position is 0 or more.");
          // The pages after it move down one, so the order stays what people chose.
          run(
            "UPDATE pages SET position = position + 1 WHERE space = ? AND parent_id IS ? AND position >= ? AND id != ?",
            target.key,
            parent,
            position as number,
            id,
          );
          run("UPDATE pages SET space = ?, parent_id = ?, position = ? WHERE id = ?", target.key, parent, position as number, id);
          if (target.key !== row.space) {
            // The pages under it go with it.
            const move = (pid: string) => {
              for (const c of q<{ id: string }>("SELECT id FROM pages WHERE parent_id = ?", pid)) {
                run("UPDATE pages SET space = ? WHERE id = ?", target.key, c.id);
                move(c.id);
              }
            };
            move(id);
          }
        }
      });
      return detail(who, id);
    },

    remove(who: Actor, id: string) {
      const { row, space, role } = needs(who, id, "editor");
      if (one("SELECT 1 FROM pages WHERE parent_id = ?", id)) throw new WikiError(409, "conflict", "Move or delete the pages under it first.");
      if (row.is_policy && !can(role, "admin")) throw new WikiError(403, "forbidden", `Only admins of ${space.name} delete a policy.`);
      tx(() => {
        run("DELETE FROM search_index WHERE page_id = ?", id);
        run("DELETE FROM views WHERE page_id = ?", id);
        run("UPDATE pages SET position = position - 1 WHERE space = ? AND parent_id IS ? AND position > ?", row.space, row.parent_id, row.position);
        run("DELETE FROM pages WHERE id = ?", id);
      });
      presence.delete(id);
    },

    // ---------------------------------------------------------------- History

    revisions(who: Actor, id: string) {
      readable(who, id);
      return { changes: q<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? ORDER BY id DESC", id).map(change) };
    },

    revision(who: Actor, id: string, n: number) {
      readable(who, id);
      const r = one<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? AND n = ? AND kind != 'review' ORDER BY id DESC LIMIT 1", id, n);
      if (!r) throw new WikiError(404, "not-found", "No such revision.");
      return { ...change(r), title: r.title, html: sanitize(r.html) };
    },

    diff(who: Actor, id: string, from: number, to: number): { from: number; to: number; title: { before: string; after: string }; changes: Change[] } {
      readable(who, id);
      const get = (n: number) => one<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? AND n = ? AND kind != 'review' ORDER BY id DESC LIMIT 1", id, n);
      const a = from === 0 ? { title: "", html: "" } : get(from);
      const b = get(to);
      if (!a || !b) throw new WikiError(404, "not-found", "No such revision.");
      return { from, to, title: { before: a.title, after: b.title }, changes: diff(sanitize(a.html), sanitize(b.html)) };
    },

    restore(who: Actor, id: string, n: number) {
      const { row } = needs(who, id, "editor");
      const r = one<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? AND n = ? AND kind != 'review' ORDER BY id DESC LIMIT 1", id, n);
      if (!r) throw new WikiError(404, "not-found", "No such revision.");
      return publish(who, id, {
        baseRevision: row.revision,
        title: r.title,
        html: r.html,
        note: `Restored revision ${n}`,
        notify: "followers",
        kind: "restore",
      });
    },

    review(who: Actor, id: string, raw: unknown) {
      const b = body(raw ?? {});
      const { row } = needs(who, id, "editor");
      const note = b.note === undefined || b.note === null || b.note === "" ? "Reviewed, no changes" : str(b.note, "note", 200);
      tx(() => {
        run("UPDATE pages SET reviewed_at = ?, reviewed_by = ? WHERE id = ?", now(), who.name, id);
        addRevision(row, row.revision, "review", who, note);
      });
      return detail(who, id);
    },

    // ---------------------------------------------------------------- Drafts and presence

    draft(who: Actor, id: string) {
      readable(who, id);
      const d = one<{ base: number; title: string; html: string; saved_at: string }>("SELECT * FROM drafts WHERE page_id = ? AND who = ?", id, who.key);
      if (!d) throw new WikiError(404, "not-found", "No draft.");
      return { base: d.base, title: d.title, html: sanitize(d.html), savedAt: d.saved_at };
    },

    saveDraft(who: Actor, id: string, raw: unknown) {
      const b = body(raw);
      const { row } = needs(who, id, "editor");
      if (!Number.isInteger(b.base) || (b.base as number) < 1 || (b.base as number) > row.revision)
        throw new WikiError(422, "invalid-body", `base is the revision the draft started from, 1 to ${row.revision}.`);
      const title = str(b.title, "title", 200);
      if (typeof b.html !== "string" || b.html.length > MAX_HTML) throw new WikiError(422, "invalid-body", "html is a text of up to 2 MiB.");
      const t = now();
      run(
        "INSERT INTO drafts (page_id, who, base, title, html, saved_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (page_id, who) DO UPDATE SET base = excluded.base, title = excluded.title, html = excluded.html, saved_at = excluded.saved_at",
        id,
        who.key,
        b.base as number,
        title,
        sanitize(b.html),
        t,
      );
      return { base: b.base as number, savedAt: t, revision: row.revision };
    },

    dropDraft(who: Actor, id: string) {
      readable(who, id);
      run("DELETE FROM drafts WHERE page_id = ? AND who = ?", id, who.key);
    },

    /** Says who has the page open, and whether and where they are editing; answers who else has. */
    here(who: Actor, id: string, raw: unknown) {
      const b = body(raw ?? {});
      const { row, role } = readable(who, id);
      const editing = b.editing === true && can(role, "editor");
      const section = typeof b.section === "string" && b.section.trim() ? b.section.trim().slice(0, 200) : null;
      if (b.leave === true) presence.get(id)?.delete(who.key);
      else {
        if (!presence.has(id)) presence.set(id, new Map());
        presence.get(id)!.set(who.key, { name: who.name, email: who.email, editing, section, at: clock() });
      }
      const last = one<RevisionRow>("SELECT * FROM revisions WHERE page_id = ? AND kind != 'review' ORDER BY id DESC LIMIT 1", id);
      return {
        revision: row.revision,
        lastChange: last ? change(last) : null,
        people: presenceOf(id, who.key),
      };
    },

    follow(who: Actor, id: string, on: boolean) {
      readable(who, id);
      if (!who.email) throw new WikiError(403, "forbidden", "Only people follow pages, not API tokens.");
      if (on) follow(id, who);
      else run("DELETE FROM follows WHERE page_id = ? AND email = ?", id, who.email);
      return { following: on };
    },

    // ---------------------------------------------------------------- Comments

    comments(who: Actor, id: string) {
      const { role } = readable(who, id);
      return {
        comments: q<{
          id: string;
          parent_id: string | null;
          body: string;
          by_email: string | null;
          by_name: string;
          at: string;
          resolved_at: string | null;
          resolved_by: string | null;
        }>("SELECT * FROM comments WHERE page_id = ? ORDER BY at", id).map((c) => ({
          id: c.id,
          parent: c.parent_id,
          body: c.body,
          by: { email: c.by_email, name: c.by_name },
          at: c.at,
          resolvedAt: c.resolved_at,
          resolvedBy: c.resolved_by,
          canDelete: (!!who.email && c.by_email === who.email) || can(role, "admin"),
        })),
      };
    },

    comment(who: Actor, id: string, raw: unknown) {
      const b = body(raw);
      readable(who, id);
      const text = str(b.body, "body", 4000);
      let parent: string | null = null;
      if (b.parent !== undefined && b.parent !== null) {
        const p =
          typeof b.parent === "string"
            ? one<{ id: string; parent_id: string | null }>("SELECT id, parent_id FROM comments WHERE id = ? AND page_id = ?", b.parent, id)
            : undefined;
        if (!p) throw new WikiError(422, "invalid-body", "parent is a comment on this page.");
        parent = p.parent_id ?? p.id;
      }
      const cid = newId();
      run(
        "INSERT INTO comments (id, page_id, parent_id, body, by_email, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        cid,
        id,
        parent,
        text,
        who.email,
        who.name,
        now(),
      );
      return { id: cid, parent, body: text, by: { email: who.email, name: who.name }, at: now(), resolvedAt: null, resolvedBy: null, canDelete: true };
    },

    resolveComment(who: Actor, cid: string, raw: unknown) {
      const b = body(raw);
      const c = one<{ id: string; page_id: string; by_email: string | null }>("SELECT id, page_id, by_email FROM comments WHERE id = ?", cid);
      if (!c) throw new WikiError(404, "not-found", "No such comment.");
      const { role } = readable(who, c.page_id);
      if (!can(role, "editor") && c.by_email !== who.email) throw new WikiError(403, "forbidden", "Editors of the space and the comment's writer resolve it.");
      if (typeof b.resolved !== "boolean") throw new WikiError(422, "invalid-body", "resolved is true or false.");
      run("UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?", b.resolved ? now() : null, b.resolved ? who.name : null, cid);
      return this.comments(who, c.page_id).comments.find((x) => x.id === cid)!;
    },

    deleteComment(who: Actor, cid: string) {
      const c = one<{ page_id: string; by_email: string | null }>("SELECT page_id, by_email FROM comments WHERE id = ?", cid);
      if (!c) throw new WikiError(404, "not-found", "No such comment.");
      const { role } = readable(who, c.page_id);
      if (!(who.email && c.by_email === who.email) && !can(role, "admin"))
        throw new WikiError(403, "forbidden", "Only its writer or an admin of the space deletes a comment.");
      run("DELETE FROM comments WHERE id = ?", cid);
    },

    // ---------------------------------------------------------------- Attachments

    attach(who: Actor, id: string, name: string, type: string, data: Buffer) {
      needs(who, id, "editor");
      const max = cfg().attachments.maxBytes;
      if (data.length > max) throw new WikiError(413, "payload-too-large", `A file is at most ${Math.round(max / 1024 / 1024)} MB (attachments.max_size).`);
      if (!data.length) throw new WikiError(422, "invalid-body", "The file is empty.");
      const clean = fileName(name.replace(/^.*[\\/]/, "")).slice(0, 120);
      const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type) ? type.toLowerCase() : "application/octet-stream";
      const aid = newId();
      run(
        "INSERT INTO attachments (id, page_id, name, type, size, data, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        aid,
        id,
        clean,
        mime,
        data.length,
        data,
        who.name,
        now(),
      );
      return { id: aid, name: clean, type: mime, size: data.length, url: `/api/v1/attachments/${aid}/${encodeURIComponent(clean)}`, by: who.name, at: now() };
    },

    attachments(who: Actor, id: string) {
      const { row } = readable(who, id);
      const used = new Set(attachmentIds(row.html));
      return {
        attachments: q<{ id: string; name: string; type: string; size: number; by_name: string; at: string }>(
          "SELECT id, name, type, size, by_name, at FROM attachments WHERE page_id = ? ORDER BY at",
          id,
        ).map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          size: a.size,
          url: `/api/v1/attachments/${a.id}/${encodeURIComponent(a.name)}`,
          by: a.by_name,
          at: a.at,
          used: used.has(a.id),
        })),
      };
    },

    file(who: Actor, aid: string) {
      const a = ID.test(aid)
        ? one<{ page_id: string; name: string; type: string; data: Uint8Array }>("SELECT page_id, name, type, data FROM attachments WHERE id = ?", aid)
        : undefined;
      if (!a) throw new WikiError(404, "not-found", "No such file.");
      readable(who, a.page_id);
      return { name: a.name, type: a.type, data: Buffer.from(a.data) };
    },

    detach(who: Actor, aid: string) {
      const a = ID.test(aid) ? one<{ page_id: string }>("SELECT page_id FROM attachments WHERE id = ?", aid) : undefined;
      if (!a) throw new WikiError(404, "not-found", "No such file.");
      needs(who, a.page_id, "editor");
      run("DELETE FROM attachments WHERE id = ?", aid);
    },

    // ---------------------------------------------------------------- Search

    search(who: Actor, text: string, spaceKey?: string | null) {
      const words = terms(text.slice(0, 200));
      if (!words.length) return { query: text, results: [] as SearchResult[] };
      const c = cfg();
      const allowed = new Map(c.spaces.filter((s) => roleIn(who, s) && (!spaceKey || s.key === spaceKey)).map((s) => [s.key, s]));
      const match = (op: string) => words.map((t) => `"${t.replace(/"/g, "")}"*`).join(` ${op} `);
      const find = (op: string) =>
        q<{ page_id: string }>("SELECT page_id FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index, 0, 5.0, 1.0) LIMIT 500", match(op));
      let hits = find("AND");
      if (!hits.length && words.length > 1) hits = find("OR");
      const results: SearchResult[] = [];
      for (const h of hits) {
        const r = one<PageRow>("SELECT * FROM pages WHERE id = ?", h.page_id);
        const s = r && allowed.get(r.space);
        if (!r || !s) continue;
        results.push({
          id: r.id,
          title: r.title,
          space: { key: s.key, name: s.name },
          path: ancestors(r).map((a) => a.title),
          snippet: snippet(r.text, words),
          policy: !!r.is_policy,
          updatedAt: r.updated_at,
        });
        if (results.length >= 30) break;
      }
      return { query: text, results };
    },

    // ---------------------------------------------------------------- Review

    toReview(who: Actor) {
      const c = cfg();
      const people = known();
      const pages: Array<Record<string, unknown> & { overdueDays: number; views: number }> = [];
      let total = 0;
      let reviewedThisMonth = 0;
      let reviewedLastMonth = 0;
      const d = new Date(clock());
      const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
      const lastMonthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString();
      const spaces = c.spaces.filter((s) => roleIn(who, s));
      for (const s of spaces) {
        for (const r of q<PageRow>("SELECT * FROM pages WHERE space = ?", s.key)) {
          total++;
          const rv = reviewOf(r, s);
          if (rv.overdueDays === null) continue;
          pages.push({
            id: r.id,
            title: r.title,
            space: { key: s.key, name: s.name },
            owner: r.owner_email ? { email: r.owner_email, name: people.get(r.owner_email)?.name ?? r.owner_name ?? r.owner_email } : null,
            ownerGone: ownerGone(r, people),
            reviewedAt: rv.reviewedAt,
            due: rv.due,
            overdueDays: rv.overdueDays,
            views: views30(r.id),
          });
        }
        const ids = q<{ id: string }>("SELECT id FROM pages WHERE space = ?", s.key).map((x) => x.id);
        for (const id of ids) {
          reviewedThisMonth += (one<{ n: number }>("SELECT COUNT(*) AS n FROM revisions WHERE page_id = ? AND kind = 'review' AND at >= ?", id, monthStart)
            ?.n ?? 0) as number;
          reviewedLastMonth += (one<{ n: number }>(
            "SELECT COUNT(*) AS n FROM revisions WHERE page_id = ? AND kind = 'review' AND at >= ? AND at < ?",
            id,
            lastMonthStart,
            monthStart,
          )?.n ?? 0) as number;
        }
      }
      // The most read and the longest overdue first.
      pages.sort((a, b) => b.views - a.views || b.overdueDays - a.overdueDays);
      return {
        totals: {
          pages: total,
          spaces: spaces.length,
          toReview: pages.length,
          overdue60: pages.filter((p) => p.overdueDays > 60).length,
          ownerGone: pages.filter((p) => p.ownerGone).length,
          reviewedThisMonth,
          reviewedLastMonth,
        },
        spaces: spaces.map((s) => ({ key: s.key, name: s.name, reviewDays: s.reviewDays })),
        pages,
      };
    },

    // ---------------------------------------------------------------- Policies

    policies(who: Actor) {
      const c = cfg();
      const out = [];
      for (const s of c.spaces) {
        if (!roleIn(who, s)) continue;
        for (const r of q<PageRow>("SELECT * FROM pages WHERE space = ? AND is_policy = 1 ORDER BY title", s.key)) {
          const p = policyOf(r, s, who)!;
          out.push({
            id: r.id,
            title: r.title,
            space: { key: s.key, name: s.name },
            ...p,
            done: p.read >= p.readers,
            overdue: !!p.due && Date.parse(p.due) < clock() && p.read < p.readers,
          });
        }
      }
      return { readWithinDays: c.policies.readWithinDays, mail: !!mailer, policies: out };
    },

    policy(who: Actor, id: string) {
      const { row, space, role } = readable(who, id);
      if (!row.is_policy) throw new WikiError(404, "not-found", "This page is not a policy.");
      const readers = readersOf(space);
      const acks = new Map(
        q<{ email: string; name: string; at: string }>(
          "SELECT email, name, at FROM acknowledgements WHERE page_id = ? AND version = ?",
          id,
          row.policy_version,
        ).map((a) => [a.email, a]),
      );
      const p = policyOf(row, space, who)!;
      // Who has read it is shown to the space's editors; readers see only their own.
      const full = can(role, "editor");
      return {
        id: row.id,
        title: row.title,
        space: { key: space.key, name: space.name },
        ...p,
        done: p.read >= p.readers,
        overdue: !!p.due && Date.parse(p.due) < clock() && p.read < p.readers,
        notRead: full
          ? readers
              .filter((r) => !acks.has(r.email))
              .map((r) => ({ email: r.email, name: r.name, groups: r.groups.filter((g) => g !== EVERYONE), signedIn: r.signedIn }))
          : [],
        readBy: full ? readers.filter((r) => acks.has(r.email)).map((r) => ({ email: r.email, name: r.name, at: acks.get(r.email)!.at })) : [],
        reminders: q<{ at: string; sent: number; by_name: string }>(
          "SELECT at, sent, by_name FROM reminders WHERE page_id = ? AND version = ? ORDER BY at DESC",
          id,
          row.policy_version,
        ).map((x) => ({ at: x.at, sent: x.sent, by: x.by_name })),
        canRemind: full,
      };
    },

    acknowledge(who: Actor, id: string, raw: unknown) {
      const b = body(raw);
      const { row } = readable(who, id);
      if (!row.is_policy) throw new WikiError(409, "conflict", "This page is not a policy.");
      if (!who.email) throw new WikiError(403, "forbidden", "Only people confirm they have read a policy, not API tokens.");
      if (b.version !== row.policy_version)
        throw new WikiError(409, "conflict", `The policy is at version ${row.policy_version} now; read it again and confirm that one.`);
      run(
        "INSERT OR IGNORE INTO acknowledgements (page_id, version, email, name, at) VALUES (?, ?, ?, ?, ?)",
        id,
        row.policy_version,
        who.email,
        who.name,
        now(),
      );
      return detail(who, id);
    },

    /** Emails everyone who has not read the current version, and answers how many messages the mail server took. */
    async remind(who: Actor, id: string) {
      const { row, space } = needs(who, id, "editor");
      if (!row.is_policy) throw new WikiError(409, "conflict", "This page is not a policy.");
      if (!mailer) throw new WikiError(409, "conflict", "No mail server is set: add mail to wiki.yaml to send reminders.");
      const acks = new Set(
        q<{ email: string }>("SELECT email FROM acknowledgements WHERE page_id = ? AND version = ?", id, row.policy_version).map((a) => a.email),
      );
      const to = readersOf(space).filter((r) => !acks.has(r.email));
      const due = policyOf(row, space, null)!.due;
      const m = mailer;
      const text = (name: string) =>
        [
          `Hello ${name},`,
          "",
          `Please read version ${row.policy_version} of ${row.title} and confirm at the end of the page that you have read it${due ? `, by ${due.slice(0, 10)}` : ""}.`,
          "",
          pageUrl(id),
        ].join("\n");
      const results = await Promise.allSettled(to.map((p) => m.send({ to: p.email, subject: `Please read ${row.title}`, text: text(p.name) })));
      results.forEach((r, i) => r.status === "rejected" && opts.onMailError?.(r.reason, to[i]!.email));
      const sent = results.filter((r) => r.status === "fulfilled").length;
      run("INSERT INTO reminders (page_id, version, at, sent, by_name) VALUES (?, ?, ?, ?, ?)", id, row.policy_version, now(), sent, who.name);
      return { sent, failed: to.length - sent };
    },

    acknowledgementsCsv(who: Actor, id: string): string {
      const { row, space } = needs(who, id, "editor");
      if (!row.is_policy) throw new WikiError(404, "not-found", "This page is not a policy.");
      const cell = (s: string) => (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s);
      const lines = ["policy,space,version,email,name,read_at"];
      for (const a of q<{ version: number; email: string; name: string; at: string }>(
        "SELECT version, email, name, at FROM acknowledgements WHERE page_id = ? ORDER BY version, at",
        id,
      ))
        lines.push([row.title, space.name, String(a.version), a.email, a.name, a.at].map(cell).join(","));
      return lines.join("\r\n") + "\r\n";
    },

    // ---------------------------------------------------------------- Templates, import and export

    templates(who: Actor) {
      const own = [];
      for (const s of cfg().spaces) {
        if (!roleIn(who, s)) continue;
        for (const r of q<PageRow>("SELECT * FROM pages WHERE space = ? AND is_template = 1 ORDER BY title", s.key))
          own.push({ id: `page:${r.id}`, name: r.title, description: excerpt(r.text, 120), space: s.key, html: sanitize(r.html) });
      }
      return { templates: [...TEMPLATES.map((t) => ({ ...t, space: null })), ...own] };
    },

    importFiles(who: Actor, raw: unknown) {
      const b = body(raw);
      const space = spaceNeeds(who, b.space, "editor");
      const parent = parentIn(who, b.parent, space);
      const format = b.format as Format;
      if (format !== "markdown" && format !== "html") throw new WikiError(422, "invalid-body", "format is markdown or html.");
      if (!Array.isArray(b.files) || !b.files.length || b.files.length > 200)
        throw new WikiError(422, "invalid-body", "files is a list of 1 to 200 { name, content }.");
      const files = b.files.map((f, i) => {
        if (!isObj(f) || typeof f.name !== "string" || typeof f.content !== "string")
          throw new WikiError(422, "invalid-body", `files[${i}] is { name, content }.`);
        return importFile(f.name, f.content, format);
      });
      const ids = tx(() => files.map((f) => insertPage(who, space, parent, f.title, f.html, "import")));
      return { pages: ids.map((id) => summaryRow(one<PageRow>("SELECT * FROM pages WHERE id = ?", id)!, space)) };
    },

    exportPage(who: Actor, id: string, format: string) {
      const { row, space } = readable(who, id);
      const base = fileName(row.title);
      if (format === "markdown") return { name: `${base}.md`, type: "text/markdown; charset=utf-8", body: markdownFor(row, row.html) };
      if (format === "html")
        return {
          name: `${base}.html`,
          type: "text/html; charset=utf-8",
          body: htmlDocument(row.title, row.html, `${space.name} · revision ${row.revision} · ${row.updated_at.slice(0, 10)}`),
        };
      throw new WikiError(422, "invalid-body", "format is markdown or html.");
    },

    /** A space as a ZIP of Markdown files in the page tree's folders, with its files, and links between them kept. */
    exportSpace(who: Actor, key: string) {
      const space = spaceNeeds(who, key, "viewer");
      const { rows, paths } = pagePaths(space);
      const entries = [];
      const files = new Map<string, string>();
      for (const a of q<{ id: string; page_id: string; name: string; data: Uint8Array }>(
        "SELECT a.id, a.page_id, a.name, a.data FROM attachments a JOIN pages p ON p.id = a.page_id WHERE p.space = ?",
        space.key,
      )) {
        const path = `files/${a.id}-${fileName(a.name)}`;
        files.set(a.id, path);
        entries.push({ path: `${fileName(space.name)}/${path}`, data: Buffer.from(a.data) });
      }
      for (const r of rows) {
        const path = `${paths.get(r.id)!}.md`;
        const dir = posix.dirname(path);
        const rel = (to: string) => posix.relative(dir, to) || ".";
        const md = markdownFor(r, r.html)
          .replace(/\]\(\/pages\/([A-Za-z0-9_-]+)\)/g, (m, id: string) => (paths.has(id) ? `](${encodeURI(rel(`${paths.get(id)!}.md`))})` : m))
          .replace(/\(\/api\/v1\/attachments\/([A-Za-z0-9_-]+)(\/[^)\s]*)?\)/g, (m, id: string) => (files.has(id) ? `(${encodeURI(rel(files.get(id)!))})` : m));
        entries.push({ path: `${fileName(space.name)}/${path}`, data: Buffer.from(md, "utf8") });
      }
      return { name: `${fileName(space.name)}.zip`, body: zip(entries, new Date(clock())) };
    },

    /** Old views go after 400 days; presence that has not been renewed goes at once. */
    purge() {
      run("DELETE FROM views WHERE day < ?", new Date(clock() - 400 * DAY).toISOString().slice(0, 10));
      for (const id of presence.keys()) if (!presenceOf(id).length) presence.delete(id);
    },
  };
}

export interface SearchResult {
  id: string;
  title: string;
  space: { key: string; name: string };
  path: string[];
  snippet: Segment[];
  policy: boolean;
  updatedAt: string;
}

export type Wiki = ReturnType<typeof createWiki>;
