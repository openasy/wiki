import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `-- People who signed in, with the groups their identity provider sent at their last sign-in.
   CREATE TABLE people (email TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, groups TEXT NOT NULL DEFAULT '[]', seen_at TEXT NOT NULL);
   -- Identity's directory, when the file names it: everyone, signed in here or not, so a policy knows who has not read it.
   CREATE TABLE directory (email TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, groups TEXT NOT NULL, synced_at TEXT NOT NULL);
   -- A page in a space (a key from the file), under another page or at the space's top. html is sanitized; text is
   -- its words, for the search. revision counts every published change.
   CREATE TABLE pages (
     id TEXT PRIMARY KEY,
     space TEXT NOT NULL,
     parent_id TEXT REFERENCES pages (id),
     position INTEGER NOT NULL DEFAULT 0,
     title TEXT NOT NULL,
     html TEXT NOT NULL,
     text TEXT NOT NULL,
     revision INTEGER NOT NULL,
     owner_email TEXT,
     owner_name TEXT,
     is_policy INTEGER NOT NULL DEFAULT 0,
     -- The revision people are asked to read; a small fix to a policy keeps it.
     policy_revision INTEGER,
     policy_version INTEGER NOT NULL DEFAULT 0,
     policy_changed_at TEXT,
     is_template INTEGER NOT NULL DEFAULT 0,
     reviewed_at TEXT NOT NULL,
     reviewed_by TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE INDEX pages_space ON pages (space, parent_id, position);
   -- Every published version of a page, and reviews that changed nothing.
   CREATE TABLE revisions (
     id INTEGER PRIMARY KEY,
     page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     n INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'restore', 'review', 'import', 'api')),
     title TEXT NOT NULL,
     html TEXT NOT NULL,
     note TEXT,
     by_email TEXT,
     by_name TEXT NOT NULL,
     at TEXT NOT NULL,
     -- 1 when it was merged with a change published while it was being written.
     merged INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX revisions_page ON revisions (page_id, n);
   -- What someone is writing and has not published, saved as they type.
   CREATE TABLE drafts (
     page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     who TEXT NOT NULL,
     base INTEGER NOT NULL,
     title TEXT NOT NULL,
     html TEXT NOT NULL,
     saved_at TEXT NOT NULL,
     PRIMARY KEY (page_id, who)
   );
   -- Links between pages, from the published html, for "Linked from".
   CREATE TABLE links (from_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE, to_id TEXT NOT NULL, PRIMARY KEY (from_id, to_id)) WITHOUT ROWID;
   CREATE INDEX links_to ON links (to_id);
   -- The published words, folded (lowercase, no accents, Turkish i alike).
   CREATE VIRTUAL TABLE search_index USING fts5(page_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
   CREATE TABLE views (page_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (page_id, day)) WITHOUT ROWID;
   CREATE TABLE follows (page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE, email TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (page_id, email)) WITHOUT ROWID;
   CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     parent_id TEXT REFERENCES comments (id) ON DELETE CASCADE,
     body TEXT NOT NULL,
     by_email TEXT,
     by_name TEXT NOT NULL,
     at TEXT NOT NULL,
     resolved_at TEXT,
     resolved_by TEXT
   );
   CREATE INDEX comments_page ON comments (page_id, at);
   CREATE TABLE attachments (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     data BLOB NOT NULL,
     by_name TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE INDEX attachments_page ON attachments (page_id);
   -- "I have read this", per version of a policy.
   CREATE TABLE acknowledgements (
     page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     email TEXT NOT NULL,
     name TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (page_id, version, email)
   ) WITHOUT ROWID;
   CREATE TABLE reminders (page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE, version INTEGER NOT NULL, at TEXT NOT NULL, sent INTEGER NOT NULL, by_name TEXT NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
