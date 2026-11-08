// Starts the app on a random port for tests, and the people the tests act as.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { createAuth, type Role } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import type { Mail } from "./mail.ts";
import { createWiki, type Actor } from "./wiki.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** The settings file the tests start with. */
export const SETTINGS = `
wiki:
  name: Acme handbook
spaces:
  - key: engineering
    name: Engineering
    review: 6 months
    readers: [engineering]
    editors: [engineering]
    admins: [engineering-leads]
  - key: people
    name: People
    review: 12 months
    readers: [everyone]
    editors: [people-team]
  - key: sales
    name: Sales
    readers: [sales]
    editors: [sales]
policies:
  read_within: 14 days
groups:
  engineering: [emre@example.com, dana@example.com]
  engineering-leads: [dana@example.com]
  people-team: [selin@example.com]
  sales: [sam@example.com]
mail:
  host: mail.example.com
  from: Wiki <wiki@example.com>
`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-11-02T12:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

/** A member of the wiki, as @openasy/auth keeps them, and the actor they are when signed in. */
export function person(db: DatabaseSync, email: string, name: string, role: Role = "user", status = "active"): Actor {
  db.prepare("INSERT OR REPLACE INTO auth_users (id, email, name, role, status, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    `u-${email}`,
    email,
    name,
    role,
    status,
    "2026-01-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
  );
  return { key: email, email, name, role };
}

export function people(db: DatabaseSync) {
  return {
    emre: person(db, "emre@example.com", "Emre Aydın"),
    dana: person(db, "dana@example.com", "Dana Whitfield"),
    selin: person(db, "selin@example.com", "Selin Kaya"),
    sam: person(db, "sam@example.com", "Sam Porter"),
    owner: person(db, "owner@example.com", "Olcay Owner", "owner"),
  };
}

export function createTestWiki(settings = SETTINGS) {
  const db = openDb(":memory:");
  const auth = createAuth({ db, product: "wiki", productName: "OpenAsy Wiki", origin: "http://localhost" });
  const clock = fakeClock();
  const sent: Mail[] = [];
  const wiki = createWiki(db, {
    publicUrl: "https://wiki.example.com",
    clock,
    env: {},
    mailerFor: () => ({ send: async (m) => void sent.push(m), close: () => {} }),
  });
  wiki.setConfig(parseConfig(settings), settings);
  return { db, auth, wiki, clock, sent, ...people(db) };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; settings?: string }) {
  const t = createTestWiki(opts.settings);
  const { settings: _, ...rest } = opts;
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  handler = createApp({ db: t.db, wiki: t.wiki, auth: t.auth, adminToken: ADMIN_TOKEN, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { ...t, base, admin, close };
}
