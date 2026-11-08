import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { WikiError, type Actor, type ProblemCode, type Wiki } from "./wiki.ts";

export interface AppOptions {
  db: DatabaseSync;
  wiki: Wiki;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(wiki: Wiki, version: string) {
  return renderMetrics(version, { ...wiki.gauges(), fileError: !!wiki.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (WIKI_METRICS_PORT). */
export function createMetricsHandler(wiki: Wiki, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(wiki, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The pages run nothing from elsewhere. Pages may show images from any https address, as imported pages often do. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
};

/** Pictures the browser shows on the page; every other file is downloaded, never opened by the browser. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "forbidden-origin": "Origin not allowed",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "edit-conflict": "Edit conflict",
  "payload-too-large": "Payload too large",
  "unsupported-media-type": "Unsupported media type",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, extra?: Record<string, unknown>) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }), ...extra };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new WikiError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body of up to `limit` bytes. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readRaw(req, limit)).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new WikiError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A file name for Content-Disposition: plain ASCII, and the full name in UTF-8. */
const disposition = (kind: "inline" | "attachment", name: string) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * The role a route needs (ADR 0003). "user" is anyone signed in: what they see in each space comes from the space's
 * groups, which the wiki checks itself. "none" is for the version only.
 */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest body taken, in bytes. Default 4 MiB. */
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({ db, wiki, version, auth, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const int = (v: string | undefined, name: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new WikiError(422, "invalid-body", `${name} is a revision number.`);
    return n;
  };
  const download = (res: ServerResponse, name: string, type: string, body: string | Buffer) =>
    send(res, 200, body, type, { "content-disposition": disposition("attachment", name), "cache-control": "no-store" });

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "wiki", version }) },
    { method: "GET", path: "/api/v1/products", auth: "user", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "user", handle: ({ who }) => wiki.summary(who) },
    { method: "GET", path: "/api/v1/me", auth: "user", handle: ({ who }) => wiki.me(who) },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: "/api/v1/settings", auth: "user", handle: () => wiki.settings() },
    { method: "GET", path: "/api/v1/team", auth: "user", handle: () => ({ people: wiki.team() }) },

    { method: "GET", path: "/api/v1/spaces", auth: "user", handle: ({ who }) => ({ spaces: wiki.spaces(who) }) },
    { method: "GET", path: "/api/v1/spaces/:key/pages", auth: "user", handle: ({ who, params }) => wiki.tree(who, params[0]!) },
    {
      method: "GET",
      path: "/api/v1/spaces/:key/export",
      auth: "user",
      handle: ({ res, who, params }) => {
        const z = wiki.exportSpace(who, params[0]!);
        download(res, z.name, "application/zip", z.body);
      },
    },
    {
      method: "GET",
      path: "/api/v1/search",
      auth: "user",
      handle: ({ who, url }) => wiki.search(who, url.searchParams.get("q") ?? "", url.searchParams.get("space")),
    },
    { method: "GET", path: "/api/v1/find", auth: "user", handle: ({ who, url }) => ({ pages: wiki.find(who, url.searchParams.get("q") ?? "") }) },
    { method: "GET", path: "/api/v1/templates", auth: "user", handle: ({ who }) => wiki.templates(who) },
    {
      method: "POST",
      path: "/api/v1/import",
      auth: "user",
      limit: 16 * 1024 * 1024,
      handle: async ({ res, who, body }) => created(res, wiki.importFiles(who, await body())),
    },

    // Pages.
    { method: "POST", path: "/api/v1/pages", auth: "user", handle: async ({ res, who, body }) => created(res, wiki.create(who, await body())) },
    {
      method: "GET",
      path: "/api/v1/pages/:id",
      auth: "user",
      handle: ({ who, params, url }) => wiki.get(who, params[0]!, { count: url.searchParams.get("view") !== "0" }),
    },
    { method: "PATCH", path: "/api/v1/pages/:id", auth: "user", handle: async ({ who, params, body }) => wiki.update(who, params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/pages/:id", auth: "user", handle: ({ res, who, params }) => (wiki.remove(who, params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/pages/:id/publish", auth: "user", handle: async ({ who, params, body }) => wiki.publish(who, params[0]!, await body()) },
    { method: "POST", path: "/api/v1/pages/:id/review", auth: "user", handle: async ({ who, params, body }) => wiki.review(who, params[0]!, await body()) },
    { method: "GET", path: "/api/v1/pages/:id/revisions", auth: "user", handle: ({ who, params }) => wiki.revisions(who, params[0]!) },
    { method: "GET", path: "/api/v1/pages/:id/revisions/:n", auth: "user", handle: ({ who, params }) => wiki.revision(who, params[0]!, int(params[1], "n")) },
    {
      method: "POST",
      path: "/api/v1/pages/:id/revisions/:n/restore",
      auth: "user",
      handle: ({ who, params }) => wiki.restore(who, params[0]!, int(params[1], "n")),
    },
    {
      method: "GET",
      path: "/api/v1/pages/:id/diff",
      auth: "user",
      handle: ({ who, params, url }) =>
        wiki.diff(who, params[0]!, int(url.searchParams.get("from") ?? undefined, "from"), int(url.searchParams.get("to") ?? undefined, "to")),
    },
    { method: "GET", path: "/api/v1/pages/:id/draft", auth: "user", handle: ({ who, params }) => wiki.draft(who, params[0]!) },
    { method: "PUT", path: "/api/v1/pages/:id/draft", auth: "user", handle: async ({ who, params, body }) => wiki.saveDraft(who, params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/pages/:id/draft", auth: "user", handle: ({ res, who, params }) => (wiki.dropDraft(who, params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/pages/:id/presence", auth: "user", handle: async ({ who, params, body }) => wiki.here(who, params[0]!, await body()) },
    { method: "PUT", path: "/api/v1/pages/:id/follow", auth: "user", handle: ({ who, params }) => wiki.follow(who, params[0]!, true) },
    { method: "DELETE", path: "/api/v1/pages/:id/follow", auth: "user", handle: ({ who, params }) => wiki.follow(who, params[0]!, false) },
    {
      method: "GET",
      path: "/api/v1/pages/:id/export",
      auth: "user",
      handle: ({ res, who, params, url }) => {
        const f = wiki.exportPage(who, params[0]!, url.searchParams.get("format") ?? "markdown");
        download(res, f.name, f.type, f.body);
      },
    },

    // Comments.
    { method: "GET", path: "/api/v1/pages/:id/comments", auth: "user", handle: ({ who, params }) => wiki.comments(who, params[0]!) },
    {
      method: "POST",
      path: "/api/v1/pages/:id/comments",
      auth: "user",
      handle: async ({ res, who, params, body }) => created(res, wiki.comment(who, params[0]!, await body())),
    },
    {
      method: "PATCH",
      path: "/api/v1/comments/:id",
      auth: "user",
      handle: async ({ who, params, body }) => wiki.resolveComment(who, params[0]!, await body()),
    },
    { method: "DELETE", path: "/api/v1/comments/:id", auth: "user", handle: ({ res, who, params }) => (wiki.deleteComment(who, params[0]!), noContent(res)) },

    // Attachments: the file is the body, its type the Content-Type, its name ?name=.
    { method: "GET", path: "/api/v1/pages/:id/attachments", auth: "user", handle: ({ who, params }) => wiki.attachments(who, params[0]!) },
    {
      method: "POST",
      path: "/api/v1/pages/:id/attachments",
      auth: "user",
      handle: async ({ req, res, who, params, url }) => {
        const type = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
        if (type === "application/json" || type.startsWith("multipart/"))
          throw new WikiError(415, "unsupported-media-type", "Send the file itself as the body, with its own Content-Type and ?name=.");
        const name = url.searchParams.get("name")?.trim();
        if (!name) throw new WikiError(422, "invalid-body", "name is the file's name, in the query.");
        created(res, wiki.attach(who, params[0]!, name, type, await readRaw(req, wiki.config()?.attachments.maxBytes ?? 20 * 1024 * 1024)));
      },
    },
    {
      method: "GET",
      path: "/api/v1/attachments/:id",
      auth: "user",
      handle: ({ res, who, params }) => serveAttachment(res, who, params[0]!),
    },
    {
      method: "GET",
      path: "/api/v1/attachments/:id/:name",
      auth: "user",
      handle: ({ res, who, params }) => serveAttachment(res, who, params[0]!),
    },
    { method: "DELETE", path: "/api/v1/attachments/:id", auth: "user", handle: ({ res, who, params }) => (wiki.detach(who, params[0]!), noContent(res)) },

    // Review and policies.
    { method: "GET", path: "/api/v1/review", auth: "user", handle: ({ who }) => wiki.toReview(who) },
    { method: "GET", path: "/api/v1/policies", auth: "user", handle: ({ who }) => wiki.policies(who) },
    { method: "GET", path: "/api/v1/policies/:id", auth: "user", handle: ({ who, params }) => wiki.policy(who, params[0]!) },
    {
      method: "POST",
      path: "/api/v1/policies/:id/acknowledge",
      auth: "user",
      handle: async ({ who, params, body }) => wiki.acknowledge(who, params[0]!, await body()),
    },
    { method: "POST", path: "/api/v1/policies/:id/remind", auth: "user", handle: ({ who, params }) => wiki.remind(who, params[0]!) },
    {
      method: "GET",
      path: "/api/v1/policies/:id/acknowledgements",
      auth: "user",
      handle: ({ res, who, params }) => download(res, "acknowledgements.csv", "text/csv; charset=utf-8", wiki.acknowledgementsCsv(who, params[0]!)),
    },
  ];

  function serveAttachment(res: ServerResponse, who: Actor, id: string) {
    const f = wiki.file(who, id);
    const inline = INLINE.has(f.type);
    // Even a file the browser opens runs nothing: no script, no styles, no forms, in a sandbox of its own.
    send(res, 200, f.data, inline ? f.type : "application/octet-stream", {
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": disposition(inline ? "inline" : "attachment", f.name),
      "cache-control": "private, max-age=3600",
    });
  }

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { key: "anonymous", email: null, name: "Anonymous", role: "user" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { key: "admin-token", email: null, name: "Admin token", role: "admin" };
    const p = auth.authorize(req, access);
    return p.kind === "session"
      ? { key: p.user.email.toLowerCase(), email: p.user.email.toLowerCase(), name: p.user.name, role: p.role }
      : { key: `token:${p.tokenId}`, email: null, name: p.name, role: p.role };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!wiki.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(wiki, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 4 * 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof WikiError)) throw err;
        // The rest of a body that is too large is not read: the connection ends with the answer.
        if (err.status === 413) res.setHeader("connection", "close");
        problem(res, err.status, err.code, err.message, err.extra);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Presence is renewed every few seconds by everyone with a page open; logging it would bury the rest.
    if (!["/healthz", "/metrics", "/api/v1/pages/:id/presence"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
