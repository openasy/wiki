import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "wiki-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

const BINARY = new Set(["application/zip", "application/octet-stream", "image/png"]);

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  const listed = response.content[type] ?? (BINARY.has(type) ? response.content["application/octet-stream"] : undefined);
  expect(listed, `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (BINARY.has(type)) return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown, headers: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...headers },
  ...(b !== undefined && { body: typeof b === "string" || Buffer.isBuffer(b) ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let id = "";
  let child = "";
  let policy = "";
  let file = "";
  let comment = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of [
      "/api/v1/products",
      "/api/v1/summary",
      "/api/v1/me",
      "/api/v1/settings",
      "/api/v1/team",
      "/api/v1/spaces",
      "/api/v1/templates",
      "/api/v1/review",
      "/api/v1/policies",
    ]) {
      await call("GET", p, admin());
    }
    await call("GET", "/api/v1/summary", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("pages", async () => {
    id = (await call("POST", "/api/v1/pages", admin({ space: "engineering", title: "How we deploy", template: "how-to" }))).body.id;
    child = (await call("POST", "/api/v1/pages", admin({ space: "engineering", parent: id, title: "Rolling back", markdown: "Use the **tag**." }))).body.id;
    await call("POST", "/api/v1/pages", admin({ space: "nope", title: "x" }));
    await call("POST", "/api/v1/pages", admin({ space: "engineering" }));
    await call("POST", "/api/v1/pages", admin("{"));
    await call("POST", "/api/v1/pages", { body: "{}" });
    await call("GET", "/api/v1/pages/{id}", admin(), `/api/v1/pages/${id}`);
    await call("GET", "/api/v1/pages/{id}", admin(), "/api/v1/pages/missing-page");
    await call("PATCH", "/api/v1/pages/{id}", admin({ template: true, owner: null }), `/api/v1/pages/${id}`);
    await call("PATCH", "/api/v1/pages/{id}", admin({ parent: child }), `/api/v1/pages/${id}`);
    await call("PATCH", "/api/v1/pages/{id}", admin({}), "/api/v1/pages/missing-page");
    await call("GET", "/api/v1/spaces/{key}/pages", admin(), "/api/v1/spaces/engineering/pages");
    await call("GET", "/api/v1/spaces/{key}/pages", admin(), "/api/v1/spaces/nope/pages");
    await call("GET", "/api/v1/find", admin(), "/api/v1/find?q=deploy");
    await call("POST", "/api/v1/import", admin({ space: "engineering", format: "markdown", files: [{ name: "a.md", content: "# A\n\nB" }] }));
    await call("POST", "/api/v1/import", admin({ space: "engineering", format: "pdf", files: [] }));
    await call("POST", "/api/v1/import", admin({ space: "nope", format: "markdown", files: [] }));
  });

  it("publishing, drafts, presence and history", async () => {
    await call("PUT", "/api/v1/pages/{id}/draft", admin({ base: 1, title: "How we deploy", html: "<p>Draft</p>" }), `/api/v1/pages/${id}/draft`);
    await call("PUT", "/api/v1/pages/{id}/draft", admin({ base: 9 }), `/api/v1/pages/${id}/draft`);
    await call("GET", "/api/v1/pages/{id}/draft", admin(), `/api/v1/pages/${id}/draft`);
    await call("DELETE", "/api/v1/pages/{id}/draft", admin(), `/api/v1/pages/${id}/draft`);
    await call("GET", "/api/v1/pages/{id}/draft", admin(), `/api/v1/pages/${id}/draft`);
    await call("POST", "/api/v1/pages/{id}/presence", admin({ editing: true, section: "Steps" }), `/api/v1/pages/${id}/presence`);
    await call("POST", "/api/v1/pages/{id}/presence", admin({}), "/api/v1/pages/missing-page/presence");
    await call(
      "POST",
      "/api/v1/pages/{id}/publish",
      admin({ baseRevision: 1, html: "<p>One.</p><p>Two.</p>", note: "Shorter" }),
      `/api/v1/pages/${id}/publish`,
    );
    await call("POST", "/api/v1/pages/{id}/publish", admin({ baseRevision: 2, html: "<p>One.</p><p>Theirs.</p>" }), `/api/v1/pages/${id}/publish`);
    const conflict = await call(
      "POST",
      "/api/v1/pages/{id}/publish",
      admin({ baseRevision: 2, html: "<p>One.</p><p>Mine.</p>" }),
      `/api/v1/pages/${id}/publish`,
    );
    expect(conflict.body.code).toBe("edit-conflict");
    expect(ajv.validate("openapi#/components/schemas/EditConflict", conflict.body)).toBe(true);
    await call("POST", "/api/v1/pages/{id}/publish", admin({}), `/api/v1/pages/${id}/publish`);
    await call("POST", "/api/v1/pages/{id}/publish", admin({ baseRevision: 1 }), "/api/v1/pages/missing-page/publish");
    await call("POST", "/api/v1/pages/{id}/review", admin(), `/api/v1/pages/${id}/review`);
    await call("POST", "/api/v1/pages/{id}/review", admin({ note: 7 }), `/api/v1/pages/${id}/review`);
    await call("POST", "/api/v1/pages/{id}/review", admin(), "/api/v1/pages/missing-page/review");
    await call("GET", "/api/v1/pages/{id}/revisions", admin(), `/api/v1/pages/${id}/revisions`);
    await call("GET", "/api/v1/pages/{id}/revisions", admin(), "/api/v1/pages/missing-page/revisions");
    await call("GET", "/api/v1/pages/{id}/revisions/{n}", admin(), `/api/v1/pages/${id}/revisions/1`);
    await call("GET", "/api/v1/pages/{id}/revisions/{n}", admin(), `/api/v1/pages/${id}/revisions/99`);
    await call("GET", "/api/v1/pages/{id}/revisions/{n}", admin(), `/api/v1/pages/${id}/revisions/x`);
    await call("GET", "/api/v1/pages/{id}/diff", admin(), `/api/v1/pages/${id}/diff?from=1&to=3`);
    await call("GET", "/api/v1/pages/{id}/diff", admin(), `/api/v1/pages/${id}/diff?from=0&to=99`);
    await call("GET", "/api/v1/pages/{id}/diff", admin(), `/api/v1/pages/${id}/diff?from=a`);
    await call("POST", "/api/v1/pages/{id}/revisions/{n}/restore", admin(), `/api/v1/pages/${id}/revisions/1/restore`);
    await call("POST", "/api/v1/pages/{id}/revisions/{n}/restore", admin(), `/api/v1/pages/${id}/revisions/99/restore`);
    await call("POST", "/api/v1/pages/{id}/revisions/{n}/restore", admin(), `/api/v1/pages/${id}/revisions/x/restore`);
    await call("GET", "/api/v1/search", admin(), "/api/v1/search?q=one&space=engineering");
    await call("GET", "/api/v1/pages/{id}/export", admin(), `/api/v1/pages/${id}/export?format=markdown`);
    await call("GET", "/api/v1/pages/{id}/export", admin(), `/api/v1/pages/${id}/export?format=html`);
    await call("GET", "/api/v1/pages/{id}/export", admin(), `/api/v1/pages/${id}/export?format=pdf`);
    await call("GET", "/api/v1/pages/{id}/export", admin(), "/api/v1/pages/missing-page/export");
    await call("GET", "/api/v1/spaces/{key}/export", admin(), "/api/v1/spaces/engineering/export");
    await call("GET", "/api/v1/spaces/{key}/export", admin(), "/api/v1/spaces/nope/export");
  });

  it("following and comments", async () => {
    // The admin token is no person: it cannot follow, but the answers still match.
    await call("PUT", "/api/v1/pages/{id}/follow", admin(), `/api/v1/pages/${id}/follow`);
    await call("DELETE", "/api/v1/pages/{id}/follow", admin(), `/api/v1/pages/${id}/follow`);
    await call("PUT", "/api/v1/pages/{id}/follow", admin(), "/api/v1/pages/missing-page/follow");
    await call("DELETE", "/api/v1/pages/{id}/follow", admin(), "/api/v1/pages/missing-page/follow");
    comment = (await call("POST", "/api/v1/pages/{id}/comments", admin({ body: "Which tag?" }), `/api/v1/pages/${id}/comments`)).body.id;
    await call("POST", "/api/v1/pages/{id}/comments", admin({ body: "" }), `/api/v1/pages/${id}/comments`);
    await call("POST", "/api/v1/pages/{id}/comments", admin({ body: "x" }), "/api/v1/pages/missing-page/comments");
    await call("GET", "/api/v1/pages/{id}/comments", admin(), `/api/v1/pages/${id}/comments`);
    await call("GET", "/api/v1/pages/{id}/comments", admin(), "/api/v1/pages/missing-page/comments");
    await call("PATCH", "/api/v1/comments/{id}", admin({ resolved: true }), `/api/v1/comments/${comment}`);
    await call("PATCH", "/api/v1/comments/{id}", admin({ resolved: "yes" }), `/api/v1/comments/${comment}`);
    await call("PATCH", "/api/v1/comments/{id}", admin({ resolved: true }), "/api/v1/comments/missing");
    await call("DELETE", "/api/v1/comments/{id}", admin(), `/api/v1/comments/${comment}`);
    await call("DELETE", "/api/v1/comments/{id}", admin(), `/api/v1/comments/${comment}`);
  });

  it("attachments", async () => {
    const png = { ...admin(Buffer.from("\x89PNG fake"), { "content-type": "image/png" }) };
    file = (await call("POST", "/api/v1/pages/{id}/attachments", png, `/api/v1/pages/${id}/attachments?name=diagram.png`)).body.id;
    await call("POST", "/api/v1/pages/{id}/attachments", admin({ x: 1 }), `/api/v1/pages/${id}/attachments?name=a.json`);
    await call("POST", "/api/v1/pages/{id}/attachments", png, `/api/v1/pages/${id}/attachments`);
    await call("POST", "/api/v1/pages/{id}/attachments", png, "/api/v1/pages/missing-page/attachments?name=a.png");
    await call("GET", "/api/v1/pages/{id}/attachments", admin(), `/api/v1/pages/${id}/attachments`);
    await call("GET", "/api/v1/pages/{id}/attachments", admin(), "/api/v1/pages/missing-page/attachments");
    await call("GET", "/api/v1/attachments/{id}", admin(), `/api/v1/attachments/${file}`);
    await call("GET", "/api/v1/attachments/{id}/{name}", admin(), `/api/v1/attachments/${file}/diagram.png`);
    await call("GET", "/api/v1/attachments/{id}/{name}", admin(), "/api/v1/attachments/missing-file/x.png");
    await call("DELETE", "/api/v1/attachments/{id}", admin(), `/api/v1/attachments/${file}`);
    await call("DELETE", "/api/v1/attachments/{id}", admin(), `/api/v1/attachments/${file}`);
    await call("GET", "/api/v1/attachments/{id}", admin(), `/api/v1/attachments/${file}`);
  });

  it("policies", async () => {
    policy = (await call("POST", "/api/v1/pages", admin({ space: "people", title: "Code of conduct", template: "policy", policy: true }))).body.id;
    await call("GET", "/api/v1/policies/{id}", admin(), `/api/v1/policies/${policy}`);
    await call("GET", "/api/v1/policies/{id}", admin(), `/api/v1/policies/${id}`);
    await call("POST", "/api/v1/policies/{id}/acknowledge", admin({ version: 1 }), `/api/v1/policies/${policy}/acknowledge`);
    await call("POST", "/api/v1/policies/{id}/acknowledge", admin({ version: 1 }), `/api/v1/policies/${id}/acknowledge`);
    await call("POST", "/api/v1/policies/{id}/acknowledge", admin({ version: 1 }), "/api/v1/policies/missing-page/acknowledge");
    await call("POST", "/api/v1/policies/{id}/acknowledge", admin("[1]"), `/api/v1/policies/${policy}/acknowledge`);
    await call("POST", "/api/v1/policies/{id}/remind", admin(), `/api/v1/policies/${policy}/remind`);
    await call("POST", "/api/v1/policies/{id}/remind", admin(), `/api/v1/policies/${id}/remind`);
    await call("POST", "/api/v1/policies/{id}/remind", admin(), "/api/v1/policies/missing-page/remind");
    await call("GET", "/api/v1/policies/{id}/acknowledgements", admin(), `/api/v1/policies/${policy}/acknowledgements`);
    await call("GET", "/api/v1/policies/{id}/acknowledgements", admin(), `/api/v1/policies/${id}/acknowledgements`);
    await call("GET", "/api/v1/policies", admin());
  });

  it("deleting", async () => {
    await call(
      "POST",
      "/api/v1/pages/{id}/attachments",
      admin(Buffer.alloc(21 * 1024 * 1024), { "content-type": "application/pdf" }),
      `/api/v1/pages/${id}/attachments?name=big.pdf`,
    );
    await call("DELETE", "/api/v1/pages/{id}", admin(), `/api/v1/pages/${id}`);
    await call("DELETE", "/api/v1/pages/{id}", admin(), `/api/v1/pages/${child}`);
    await call("DELETE", "/api/v1/pages/{id}", admin(), `/api/v1/pages/${child}`);
    await call("DELETE", "/api/v1/pages/{id}", {}, `/api/v1/pages/${child}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
