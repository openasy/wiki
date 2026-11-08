import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
const webDir = mkdtempSync(join(tmpdir(), "wiki-web-"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Wiki</title>");

beforeAll(async () => {
  app = await startApp({ version: "0.0.0", webDir });
});
afterAll(() => app.close());

const page = async () =>
  (await (await app.admin("/api/v1/pages", { method: "POST", body: JSON.stringify({ space: "engineering", title: "Files" }) })).json()) as { id: string };
const upload = (id: string, name: string, type: string, body: string) =>
  app.admin(`/api/v1/pages/${id}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body });

describe("the HTTP API", () => {
  it("asks for sign-in, and sends the security headers", async () => {
    const res = await fetch(`${app.base}/api/v1/spaces`);
    expect(res.status).toBe(401);
    const v = await fetch(`${app.base}/api/v1/version`);
    expect(v.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(v.headers.get("x-frame-options")).toBe("DENY");
  });

  it("shows pictures and downloads every other file, each in a sandbox", async () => {
    const { id } = await page();
    const png = (await (await upload(id, "diagram.png", "image/png", "png")).json()) as { url: string };
    const shown = await app.admin(png.url);
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(shown.headers.get("content-disposition")).toMatch(/^inline; filename="diagram.png"/);
    expect(shown.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    for (const [name, type] of [
      ["logo.svg", "image/svg+xml"],
      ["page.html", "text/html"],
    ] as const) {
      const f = (await (await upload(id, name, type, "<script>alert(1)</script>")).json()) as { url: string };
      const res = await app.admin(f.url);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const tr = (await (await upload(id, "Şema ğ.png", "image/png", "x")).json()) as { url: string };
    expect((await app.admin(tr.url)).headers.get("content-disposition")).toBe(
      `inline; filename="_ema _.png"; filename*=UTF-8''${encodeURIComponent("Şema ğ.png")}`,
    );
  });

  it("answers an edit conflict with both versions", async () => {
    const { id } = await page();
    const publish = (base: number, html: string) =>
      app.admin(`/api/v1/pages/${id}/publish`, { method: "POST", body: JSON.stringify({ baseRevision: base, html }) });
    expect((await publish(1, "<p>Theirs</p>")).status).toBe(200);
    const res = await publish(1, "<p>Mine</p>");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; revision: number; mine: { html: string }; theirs: { html: string } };
    expect(body).toMatchObject({ code: "edit-conflict", revision: 2, mine: { html: "<p>Mine</p>" }, theirs: { html: "<p>Theirs</p>" } });
  });

  it("serves exports as downloads", async () => {
    const { id } = await page();
    const md = await app.admin(`/api/v1/pages/${id}/export?format=markdown`);
    expect(md.headers.get("content-disposition")).toBe(`attachment; filename="Files.md"; filename*=UTF-8''Files.md`);
    expect(await md.text()).toBe("# Files\n\n\n");
    const zip = await app.admin("/api/v1/spaces/engineering/export");
    expect(zip.headers.get("content-type")).toBe("application/zip");
  });

  it("serves the UI for its own paths", async () => {
    const res = await fetch(`${app.base}/pages/abc`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${app.base}/api/v1/nothing`)).status).toBe(404);
  });
});
