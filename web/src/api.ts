// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

/** The settings file and whether it is applied; null before it was first read. */
export type ConfigFile = {
  path: string;
  appliedAt: string | null;
  /** Why the file on disk is not applied; the last good version stays in use. */
  error: string | null;
  warnings: string[];
} | null;

export type SpaceRole = "viewer" | "editor" | "admin";

export interface Person {
  email: string | null;
  name: string;
}

export interface SpaceConfig {
  key: string;
  name: string;
  description: string | null;
  reviewDays: number | null;
  readers: string[];
  editors: string[];
  admins: string[];
}

export interface Config {
  name: string;
  spaces: SpaceConfig[];
  policies: { readWithinDays: number };
  groups: Record<string, string[]>;
  attachments: { maxBytes: number };
  mail: { host: string; port: number; security: string; user: string | null; password: string; from: string } | null;
  identity: { url: string; token: string } | null;
}

export interface Settings {
  config: Config | null;
  yaml: string;
  file: ConfigFile;
  mail: boolean;
  directory: { url: string; at: string | null; people: number; error: string | null } | null;
}

export interface Summary {
  name: string;
  file: ConfigFile;
  spaces: number;
  pages: number;
  toReview: number;
  policiesToRead: number;
  mail: boolean;
}

export interface Space extends SpaceConfig {
  role: SpaceRole;
  pages: number;
  toReview: number;
}

export interface TreePage {
  id: string;
  title: string;
  parent: string | null;
  position: number;
  stale: boolean;
  policy: boolean;
  template: boolean;
}

export interface PageRef {
  id: string;
  title: string;
}

export interface Change {
  n: number;
  kind: "create" | "edit" | "restore" | "review" | "import" | "api";
  note: string | null;
  by: Person;
  at: string;
  merged: boolean;
}

export interface Policy {
  version: number;
  revision: number;
  changedAt: string | null;
  due: string | null;
  readers: number;
  read: number;
  readByMe: string | null;
}

export interface Here {
  name: string;
  email: string | null;
  editing: boolean;
  section: string | null;
  at: string;
}

export interface Page {
  id: string;
  space: { key: string; name: string; readers: string[]; editors: string[]; admins: string[] };
  parent: string | null;
  ancestors: PageRef[];
  title: string;
  /** Sanitized by the server; safe to show. */
  html: string;
  revision: number;
  owner: Person | null;
  ownerGone: boolean;
  review: { everyDays: number | null; reviewedAt: string; reviewedBy: string | null; due: string | null; overdueDays: number | null };
  policy: Policy | null;
  isTemplate: boolean;
  children: PageRef[];
  backlinks: PageRef[];
  changes: Change[];
  sections: string[];
  attachments: number;
  comments: number;
  following: boolean;
  presence: Here[];
  draft: { base: number; savedAt: string } | null;
  views: number;
  role: SpaceRole;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Published {
  page: Page;
  merged: boolean;
  changed: boolean;
  told: number;
}

export interface EditConflict {
  revision: number;
  by: Person;
  at: string;
  titleConflict: { mine: string; theirs: string } | null;
  conflicts: Array<{ base: string[]; mine: string[]; theirs: string[] }>;
  mine: { title: string; html: string };
  theirs: { title: string; html: string };
}

export interface DiffChange {
  kind: "same" | "added" | "removed" | "changed";
  html: string;
  words?: Array<{ text: string; kind: "same" | "added" | "removed" }>;
}

export interface Comment {
  id: string;
  parent: string | null;
  body: string;
  by: Person;
  at: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  canDelete: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
  by: string;
  at: string;
  used?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  space: { key: string; name: string };
  path: string[];
  snippet: Array<{ text: string; hit: boolean }>;
  policy: boolean;
  updatedAt: string;
}

export interface Found {
  id: string;
  title: string;
  space: { key: string; name: string };
  path: string[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  html: string;
  space: string | null;
}

export interface ReviewItem {
  id: string;
  title: string;
  space: { key: string; name: string };
  owner: Person | null;
  ownerGone: boolean;
  reviewedAt: string;
  due: string | null;
  overdueDays: number;
  views: number;
}

export interface Review {
  totals: { pages: number; spaces: number; toReview: number; overdue60: number; ownerGone: number; reviewedThisMonth: number; reviewedLastMonth: number };
  spaces: Array<{ key: string; name: string; reviewDays: number | null }>;
  pages: ReviewItem[];
}

export interface PolicyRow extends Policy {
  id: string;
  title: string;
  space: { key: string; name: string };
  done: boolean;
  overdue: boolean;
}

export interface PolicyDetail extends PolicyRow {
  notRead: Array<{ email: string; name: string; groups: string[]; signedIn: boolean }>;
  readBy: Array<{ email: string; name: string; at: string }>;
  reminders: Array<{ at: string; sent: number; by: string }>;
  canRemind: boolean;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly problem: Record<string, unknown>;
  constructor(message: string, status: number, problem: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = problem.code as string | undefined;
    this.problem = problem;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as Record<string, unknown> & { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, res.status, problem);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
