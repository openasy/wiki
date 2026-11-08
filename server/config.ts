// The wiki's settings, from one YAML file (WIKI_CONFIG): its spaces and who may read, edit and manage each one by
// Identity group, how often pages are reviewed, how long people have to read a new version of a policy, groups for
// people who sign in without Identity, the mail server and Identity's directory. As in the other products, the file is
// the only way in: no screen or API route changes these. It is applied whole or not at all, read again within a minute
// of a change, and a file with a mistake leaves the last good version in place. Pages are written in the UI.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

/** Every member is in this group, whatever their provider sends. */
export const EVERYONE = "everyone";

export interface Space {
  /** In addresses and the API: engineering. */
  key: string;
  name: string;
  description: string | null;
  /** Days a page may go without a review before it is listed for its owner; null for never. */
  reviewDays: number | null;
  /** Identity groups, by the name their groups claim carries. */
  readers: string[];
  editors: string[];
  admins: string[];
}

export interface Config {
  name: string;
  spaces: Space[];
  policies: {
    /** Days people have to read a new version of a policy. */
    readWithinDays: number;
  };
  /** Group members by email, for people who sign in without Identity or whose provider sends no groups. */
  groups: Record<string, string[]>;
  attachments: {
    /** The largest file taken, in bytes. */
    maxBytes: number;
  };
  mail: { host: string; port: number; security: "starttls" | "tls" | "none"; user: string | null; password: string; from: string } | null;
  identity: { url: string; token: string } | null;
}

const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GROUP = /^[^\s,]{1,128}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TOP = ["wiki", "spaces", "policies", "groups", "attachments", "mail", "identity"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as WIKI_SMTP_PASSWORD, never the secret itself.`);
  return v;
}

/** "6 months", "90 days", "2 weeks", "1 year", or never: a period in days, null for never. */
export function periodDays(v: unknown, at: string): number | null {
  if (v === "never" || v === false) return null;
  const m = /^(\d{1,4})\s*(days?|d|weeks?|w|months?|m|years?|y)$/.exec(String(v ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  if (!m || n < 1) throw new Error(`${at} is a period such as 90 days, 6 months or 1 year, or never.`);
  const unit = m[2]![0];
  const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
  if (days > 3650) throw new Error(`${at} is at most 10 years.`);
  return days;
}

function groupList(v: unknown, at: string): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length > 50 || list.some((g) => typeof g !== "string" || !GROUP.test(g)))
    throw new Error(`${at} is a list of up to 50 group names, such as [engineering].`);
  return [...new Set(list as string[])];
}

function size(v: unknown, at: string): number {
  const m = /^(\d{1,4})\s*(KB|MB)$/i.exec(String(v ?? "").trim());
  const n = m ? Number(m[1]) * (m[2]!.toUpperCase() === "MB" ? 1024 * 1024 : 1024) : 0;
  if (!m || n < 1024 || n > 100 * 1024 * 1024) throw new Error(`${at} is a size from 1 KB to 100 MB, such as 20 MB.`);
  return n;
}

function httpsUrl(v: unknown, at: string): string {
  const url = typeof v === "string" ? URL.parse(v.trim()) : null;
  // http:// only inside a compose network (a name without dots) or on this machine.
  const local = url && (url.hostname === "127.0.0.1" || /^[a-z0-9-]+$/.test(url.hostname));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.search)
    throw new Error(`${at} is an https:// address, such as https://id.example.com (http:// only for local names).`);
  return url.origin + url.pathname.replace(/\/$/, "");
}

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const w = doc.wiki ?? {};
  if (!isObj(w)) throw new Error("wiki is a map with name and review.");
  keys(w, "wiki", ["name", "review"]);
  const name = w.name === undefined ? "Wiki" : text(w.name, "wiki.name");
  const defaultReview = w.review === undefined ? 365 : periodDays(w.review, "wiki.review");

  const rawSpaces = doc.spaces ?? [{ key: "general", name: "General", readers: [EVERYONE], editors: [EVERYONE] }];
  if (!Array.isArray(rawSpaces) || rawSpaces.length > 200) throw new Error("spaces is a list of up to 200 spaces.");
  const spaces: Space[] = rawSpaces.map((s, i) => {
    const at = `spaces[${i}]`;
    if (!isObj(s)) throw new Error(`${at} is a map with key, name, description, review, readers, editors and admins.`);
    keys(s, at, ["key", "name", "description", "review", "readers", "editors", "admins"]);
    if (typeof s.key !== "string" || !KEY.test(s.key)) throw new Error(`${at}.key is up to 32 lowercase letters, digits and -, such as engineering.`);
    const space: Space = {
      key: s.key,
      name: text(s.name, `${at}.name`),
      description: s.description === undefined || s.description === null ? null : text(s.description, `${at}.description`, 300),
      reviewDays: s.review === undefined ? defaultReview : periodDays(s.review, `${at}.review`),
      readers: groupList(s.readers, `${at}.readers`),
      editors: groupList(s.editors, `${at}.editors`),
      admins: groupList(s.admins, `${at}.admins`),
    };
    if (!space.readers.length && !space.editors.length && !space.admins.length)
      throw new Error(`${at}: name at least one group in readers, editors or admins (everyone for every member).`);
    return space;
  });
  const dup = spaces.find((s, i) => spaces.findIndex((x) => x.key === s.key) !== i);
  if (dup) throw new Error(`The space key ${dup.key} is in the file twice.`);

  const p = doc.policies ?? {};
  if (!isObj(p)) throw new Error("policies is a map with read_within.");
  keys(p, "policies", ["read_within"]);
  const readWithin = p.read_within === undefined ? 14 : periodDays(p.read_within, "policies.read_within");
  if (readWithin === null) throw new Error("policies.read_within is a period, such as 14 days.");

  const g = doc.groups ?? {};
  if (!isObj(g)) throw new Error("groups is a map of group name to member emails, such as engineering: [ana@example.com].");
  const groups: Record<string, string[]> = {};
  for (const [group, members] of Object.entries(g)) {
    if (!GROUP.test(group) || group === EVERYONE)
      throw new Error(`groups.${group}: a group name has no spaces or commas, and everyone is every member already.`);
    if (!Array.isArray(members) || members.length > 5000 || members.some((m) => typeof m !== "string" || !EMAIL.test(m.trim())))
      throw new Error(`groups.${group} is a list of email addresses.`);
    groups[group] = [...new Set(members.map((m: string) => m.trim().toLowerCase()))];
  }

  const a = doc.attachments ?? {};
  if (!isObj(a)) throw new Error("attachments is a map with max_size.");
  keys(a, "attachments", ["max_size"]);
  const maxBytes = a.max_size === undefined ? 20 * 1024 * 1024 : size(a.max_size, "attachments.max_size");

  let mail: Config["mail"] = null;
  if (doc.mail !== undefined && doc.mail !== null) {
    const m = doc.mail;
    if (!isObj(m)) throw new Error("mail is a map with host, port, security, user, password and from.");
    keys(m, "mail", ["host", "port", "security", "user", "password", "from"]);
    const security = m.security ?? "starttls";
    if (security !== "starttls" && security !== "tls" && security !== "none") throw new Error("mail.security is starttls, tls or none.");
    const port = m.port ?? (security === "tls" ? 465 : 587);
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error("mail.port is a port number.");
    mail = {
      host: text(m.host, "mail.host", 253),
      port: port as number,
      security,
      user: m.user === undefined || m.user === null ? null : text(m.user, "mail.user", 254),
      password: m.password === undefined ? "WIKI_SMTP_PASSWORD" : env(m.password, "mail.password"),
      from: text(m.from, "mail.from", 254),
    };
  }

  let identity: Config["identity"] = null;
  if (doc.identity !== undefined && doc.identity !== null) {
    const i = doc.identity;
    if (!isObj(i)) throw new Error("identity is a map with url and token.");
    keys(i, "identity", ["url", "token"]);
    identity = { url: httpsUrl(i.url, "identity.url"), token: i.token === undefined ? "WIKI_IDENTITY_TOKEN" : env(i.token, "identity.token") };
  }

  return { name, spaces, policies: { readWithinDays: readWithin }, groups, attachments: { maxBytes }, mail, identity };
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
