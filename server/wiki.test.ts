import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { createTestWiki, person, SETTINGS } from "./test-app.ts";
import { WikiError, type Actor } from "./wiki.ts";

const DAY = 86_400_000;

function fails(fn: () => unknown): WikiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof WikiError) return err;
    throw err;
  }
  throw new Error("did not fail");
}

describe("who reads, edits and manages a space", () => {
  it("follows the space's groups, with the product role as a floor", () => {
    const t = createTestWiki();
    const roles = (who: Actor) => Object.fromEntries(t.wiki.me(who).spaces.map((s) => [s.key, s.role]));
    expect(roles(t.emre)).toEqual({ engineering: "editor", people: "viewer" });
    expect(roles(t.dana)).toEqual({ engineering: "admin", people: "viewer" });
    expect(roles(t.selin)).toEqual({ people: "editor" });
    expect(roles(t.sam)).toEqual({ people: "viewer", sales: "editor" });
    expect(roles(t.owner)).toEqual({ engineering: "admin", people: "admin", sales: "admin" });
    const viewer = person(t.db, "vic@example.com", "Vic Viewer", "viewer");
    expect(roles(viewer)).toEqual({ engineering: "viewer", people: "viewer", sales: "viewer" });
    // An API token has no groups: its role, in every space.
    expect(roles({ key: "token:1", email: null, name: "CI", role: "editor" })).toEqual({ engineering: "editor", people: "editor", sales: "editor" });
  });

  it("takes the groups Identity sent at sign-in", () => {
    const t = createTestWiki();
    const lena = person(t.db, "lena@example.com", "Lena Hart");
    expect(t.wiki.me(lena).spaces.map((s) => s.key)).toEqual(["people"]);
    t.wiki.rememberPerson("u-lena", "Lena@example.com", "Lena Hart", ["sales"]);
    expect(t.wiki.me(lena).spaces.map((s) => s.key)).toEqual(["people", "sales"]);
  });

  it("hides pages of spaces one cannot read, and refuses writing to readers", () => {
    const t = createTestWiki();
    const page = t.wiki.create(t.emre, { space: "engineering", title: "How we deploy", html: "<p>Through the pipeline.</p>" });
    expect(fails(() => t.wiki.get(t.selin, page.id)).status).toBe(404);
    expect(t.wiki.search(t.selin, "pipeline").results).toEqual([]);
    expect(t.wiki.search(t.emre, "pipeline").results.map((r) => r.title)).toEqual(["How we deploy"]);
    const doc = t.wiki.create(t.selin, { space: "people", title: "Leave policy" });
    expect(fails(() => t.wiki.publish(t.emre, doc.id, { baseRevision: 1, html: "<p>x</p>" })).status).toBe(403);
    expect(fails(() => t.wiki.create(t.emre, { space: "people", title: "x" })).status).toBe(403);
    expect(fails(() => t.wiki.create(t.emre, { space: "sales", title: "x" })).status).toBe(404);
  });
});

describe("pages", () => {
  it("are sanitized, linked both ways, and kept in every revision", () => {
    const t = createTestWiki();
    const rollback = t.wiki.create(t.emre, { space: "engineering", title: "Rolling back" });
    const deploy = t.wiki.create(t.emre, {
      space: "engineering",
      title: "How we deploy",
      html: `<p onclick="x()">Read <a href="/pages/${rollback.id}">Rolling back</a>.<script>alert(1)</script></p><iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">x</a>`,
    });
    expect(deploy.html).toBe(`<p>Read <a href="/pages/${rollback.id}">Rolling back</a>.</p><a>x</a>`);
    expect(t.wiki.get(t.emre, rollback.id).backlinks).toEqual([{ id: deploy.id, title: "How we deploy" }]);
    const r = t.wiki.publish(t.dana, deploy.id, { baseRevision: 1, html: "<p>Only the pipeline.</p>", note: "No more links" });
    expect(r.page.revision).toBe(2);
    expect(t.wiki.get(t.emre, rollback.id).backlinks).toEqual([]);
    expect(t.wiki.revisions(t.emre, deploy.id).changes.map((c) => [c.n, c.kind, c.by.name, c.note])).toEqual([
      [2, "edit", "Dana Whitfield", "No more links"],
      [1, "create", "Emre Aydın", null],
    ]);
    const d = t.wiki.diff(t.emre, deploy.id, 1, 2);
    expect(d.changes.map((c) => c.kind)).toEqual(["changed", "removed"]);
    const restored = t.wiki.restore(t.emre, deploy.id, 1);
    expect(restored.page.revision).toBe(3);
    expect(restored.page.html).toContain("Rolling back");
    expect(t.wiki.revisions(t.emre, deploy.id).changes[0]).toMatchObject({ n: 3, kind: "restore", note: "Restored revision 1" });
  });

  it("start from templates, and from Markdown", () => {
    const t = createTestWiki();
    const howTo = t.wiki.create(t.emre, { space: "engineering", title: "Request a laptop", template: "how-to" });
    expect(howTo.sections).toEqual(["Before you start", "Steps", "If something goes wrong"]);
    const md = t.wiki.create(t.emre, {
      space: "engineering",
      title: "Ports",
      markdown: "| Service | Port |\n| --- | --- |\n| api | 8080 |\n\n```sh\nmake\n```",
    });
    expect(md.html).toContain("<table>");
    expect(md.html).toContain('<code class="language-sh">make');
    t.wiki.update(t.emre, md.id, { template: true });
    const templates = t.wiki.templates(t.emre).templates.map((x) => x.id);
    expect(templates).toContain(`page:${md.id}`);
    expect(t.wiki.templates(t.selin).templates.map((x) => x.id)).not.toContain(`page:${md.id}`);
    const copy = t.wiki.create(t.emre, { space: "engineering", title: "More ports", template: `page:${md.id}` });
    expect(copy.html).toBe(md.html);
  });

  it("move in the tree, never under themselves, and take their pages to another space", () => {
    const t = createTestWiki();
    const a = t.wiki.create(t.owner, { space: "engineering", title: "A" });
    const b = t.wiki.create(t.owner, { space: "engineering", title: "B", parent: a.id });
    const c = t.wiki.create(t.owner, { space: "engineering", title: "C", parent: b.id });
    expect(t.wiki.get(t.owner, c.id).ancestors.map((x) => x.title)).toEqual(["A", "B"]);
    expect(fails(() => t.wiki.update(t.owner, a.id, { parent: c.id })).status).toBe(422);
    expect(fails(() => t.wiki.remove(t.owner, a.id)).status).toBe(409);
    t.wiki.update(t.owner, b.id, { space: "people", parent: null });
    expect(t.wiki.tree(t.owner, "people").pages.map((p) => p.title)).toEqual(["B", "C"]);
    expect(t.wiki.get(t.selin, c.id).space.key).toBe("people");
    t.wiki.remove(t.owner, c.id);
    expect(fails(() => t.wiki.get(t.owner, c.id)).status).toBe(404);
  });

  it("export as Markdown, HTML and a space's ZIP with links kept", () => {
    const t = createTestWiki();
    const a = t.wiki.create(t.emre, { space: "engineering", title: "Deploy" });
    const b = t.wiki.create(t.emre, { space: "engineering", title: "Roll/back", parent: a.id, html: `<p>See <a href="/pages/${a.id}">Deploy</a></p>` });
    const md = t.wiki.exportPage(t.emre, b.id, "markdown");
    expect(md).toMatchObject({ name: "Roll-back.md" });
    expect(md.body).toBe(`# Roll/back\n\nSee [Deploy](/pages/${a.id})\n`);
    const html = t.wiki.exportPage(t.emre, b.id, "html").body;
    expect(html).toContain("<title>Roll/back</title>");
    const z = t.wiki.exportSpace(t.emre, "engineering");
    expect(z.name).toBe("Engineering.zip");
    const text = z.body.toString("latin1");
    expect(text).toContain("Engineering/Deploy.md");
    expect(text).toContain("Engineering/Deploy/Roll-back.md");
  });
});

describe("two people editing one page", () => {
  const start = () => {
    const t = createTestWiki();
    const page = t.wiki.create(t.emre, {
      space: "engineering",
      title: "How we deploy",
      html: "<p>Intro.</p><h2>Before you merge</h2><p>CI is green.</p><h2>Rolling back</h2><p>Use the commit.</p><h2>Migrations</h2><p>Backwards compatible.</p>",
    });
    return { ...t, page };
  };

  it("keeps both changes when they touch different parts", () => {
    const t = start();
    t.wiki.publish(t.dana, t.page.id, {
      baseRevision: 1,
      html: "<p>Intro.</p><h2>Before you merge</h2><p>CI is green.</p><h2>Rolling back</h2><p>Use the commit.</p><h2>Migrations</h2><p>Backwards compatible, always.</p>",
    });
    const r = t.wiki.publish(t.emre, t.page.id, {
      baseRevision: 1,
      html: "<p>Intro, updated.</p><h2>Before you merge</h2><p>CI is green.</p><h2>Rolling back</h2><p>Use the commit.</p><h2>Migrations</h2><p>Backwards compatible.</p>",
      note: "Intro",
    });
    expect(r.merged).toBe(true);
    expect(r.page.revision).toBe(3);
    expect(r.page.html).toContain("Intro, updated.");
    expect(r.page.html).toContain("Backwards compatible, always.");
    expect(t.wiki.revisions(t.emre, t.page.id).changes[0]).toMatchObject({ merged: true, note: "Intro" });
  });

  it("refuses, with both versions, when they changed the same part", () => {
    const t = start();
    t.wiki.publish(t.dana, t.page.id, {
      baseRevision: 1,
      html: "<p>Intro.</p><h2>Before you merge</h2><p>CI is green.</p><h2>Rolling back</h2><p>Use the release tag.</p><h2>Migrations</h2><p>Backwards compatible.</p>",
    });
    const err = fails(() =>
      t.wiki.publish(t.emre, t.page.id, {
        baseRevision: 1,
        html: "<p>Intro.</p><h2>Before you merge</h2><p>CI is green.</p><h2>Rolling back</h2><p>Use the last good build.</p><h2>Migrations</h2><p>Backwards compatible.</p>",
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("edit-conflict");
    expect(err.message).toContain("Dana Whitfield");
    expect(err.extra).toMatchObject({
      revision: 2,
      conflicts: [{ base: ["<p>Use the commit.</p>"], mine: ["<p>Use the last good build.</p>"], theirs: ["<p>Use the release tag.</p>"] }],
    });
    expect(t.wiki.get(t.emre, t.page.id).revision).toBe(2);
    // Choosing mine and publishing against the revision now goes through.
    const mine = (err.extra!.mine as { html: string }).html;
    expect(t.wiki.publish(t.emre, t.page.id, { baseRevision: 2, html: mine }).page.html).toContain("last good build");
  });

  it("shows who else has the page open, and where they edit", () => {
    const t = start();
    t.wiki.here(t.dana, t.page.id, { editing: true, section: "Migrations" });
    const seen = t.wiki.here(t.emre, t.page.id, { editing: true });
    expect(seen.people).toMatchObject([{ name: "Dana Whitfield", editing: true, section: "Migrations" }]);
    t.clock.advance(31_000);
    expect(t.wiki.here(t.emre, t.page.id, {}).people).toEqual([]);
  });

  it("keeps a draft per person until it is published", () => {
    const t = start();
    t.wiki.saveDraft(t.emre, t.page.id, { base: 1, title: "How we deploy", html: "<p>Draft<script>x</script></p>" });
    expect(t.wiki.draft(t.emre, t.page.id).html).toBe("<p>Draft</p>");
    expect(fails(() => t.wiki.draft(t.dana, t.page.id)).status).toBe(404);
    expect(t.wiki.get(t.emre, t.page.id).draft).toMatchObject({ base: 1 });
    t.wiki.publish(t.emre, t.page.id, { baseRevision: 1, html: "<p>Draft</p>" });
    expect(t.wiki.get(t.emre, t.page.id).draft).toBeNull();
  });
});

describe("presence", () => {
  it("is for people who can read the page", () => {
    const t = createTestWiki();
    const p = t.wiki.create(t.emre, { space: "engineering", title: "x" });
    expect(() => t.wiki.here(t.selin, p.id, {})).toThrow(WikiError);
  });
});

describe("search", () => {
  it("finds Turkish words without their accents, and marks them in a snippet", () => {
    const t = createTestWiki();
    t.wiki.create(t.selin, { space: "people", title: "İzin politikası", html: "<p>Yıllık izin için <strong>şirket</strong> portalından başvurun.</p>" });
    t.wiki.create(t.selin, { space: "people", title: "Travel", html: "<p>Book through the travel desk.</p>" });
    for (const q of ["izin", "IZIN", "sirket portal", "yillik"]) expect(t.wiki.search(t.emre, q).results.map((r) => r.title)).toEqual(["İzin politikası"]);
    const s = t.wiki.search(t.emre, "sirket").results[0]!.snippet;
    expect(s.filter((x) => x.hit).map((x) => x.text)).toEqual(["şirket"]);
    expect(s.map((x) => x.text).join("")).toBe("Yıllık izin için şirket portalından başvurun.");
    // Any word, when no page has them all.
    expect(t.wiki.search(t.emre, "travel nothinglikethis").results.map((r) => r.title)).toEqual(["Travel"]);
    expect(t.wiki.search(t.emre, "").results).toEqual([]);
  });
});

describe("review", () => {
  it("lists pages past their space's period, the most read first, and a review takes them off", () => {
    const t = createTestWiki();
    const a = t.wiki.create(t.emre, { space: "engineering", title: "Architecture" });
    const b = t.wiki.create(t.emre, { space: "engineering", title: "Database migrations" });
    t.wiki.create(t.selin, { space: "people", title: "Leave" });
    t.clock.advance(200 * DAY);
    t.wiki.get(t.dana, b.id);
    t.wiki.get(t.emre, b.id);
    t.wiki.get(t.emre, b.id); // the same person on the same day counts once
    const list = t.wiki.toReview(t.emre);
    expect(list.pages.map((p) => [p.title, p.overdueDays, p.views])).toEqual([
      ["Database migrations", 20, 2],
      ["Architecture", 20, 0],
    ]);
    expect(list.totals).toMatchObject({ pages: 3, toReview: 2, ownerGone: 0 });
    expect(t.wiki.get(t.emre, a.id).review).toMatchObject({ everyDays: 180, overdueDays: 20 });
    t.wiki.review(t.emre, a.id, {});
    expect(t.wiki.toReview(t.emre).pages.map((p) => p.title)).toEqual(["Database migrations"]);
    expect(t.wiki.revisions(t.emre, a.id).changes[0]).toMatchObject({ kind: "review", note: "Reviewed, no changes", n: 1 });
    expect(t.wiki.toReview(t.emre).totals.reviewedThisMonth + t.wiki.toReview(t.emre).totals.reviewedLastMonth).toBe(1);
  });

  it("marks pages whose owner left, and lets anyone in the space take them", () => {
    const t = createTestWiki();
    const p = t.wiki.create(t.emre, { space: "engineering", title: "Laptops" });
    person(t.db, "emre@example.com", "Emre Aydın", "user", "disabled");
    expect(t.wiki.get(t.dana, p.id).ownerGone).toBe(true);
    const lead = person(t.db, "lee@example.com", "Lee", "editor");
    t.wiki.update(lead, p.id, { owner: "dana@example.com" });
    expect(t.wiki.get(t.dana, p.id)).toMatchObject({ owner: { email: "dana@example.com" }, ownerGone: false });
    expect(fails(() => t.wiki.update(lead, p.id, { owner: "lee@example.com" })).status).toBe(403);
    expect(fails(() => t.wiki.update(t.dana, p.id, { owner: "selin@example.com" })).status).toBe(422);
  });
});

describe("policies", () => {
  it("ask everyone who can read the space to confirm each new version", async () => {
    const t = createTestWiki();
    const p = t.wiki.create(t.selin, { space: "people", title: "Code of conduct", html: "<p>Be kind.</p>" });
    expect(fails(() => t.wiki.update(t.selin, p.id, { policy: true })).status).toBe(403);
    t.wiki.update(t.owner, p.id, { policy: true });
    let list = t.wiki.policies(t.owner).policies;
    expect(list).toMatchObject([{ title: "Code of conduct", version: 1, readers: 5, read: 0, due: "2026-11-16T12:00:00.000Z" }]);
    t.wiki.acknowledge(t.emre, p.id, { version: 1 });
    expect(fails(() => t.wiki.acknowledge(t.sam, p.id, { version: 2 })).status).toBe(409);
    expect(fails(() => t.wiki.acknowledge({ key: "token:1", email: null, name: "CI", role: "admin" }, p.id, { version: 1 })).status).toBe(403);
    const detail = t.wiki.policy(t.selin, p.id);
    expect(detail.readBy.map((r) => r.name)).toEqual(["Emre Aydın"]);
    expect(detail.notRead.map((r) => r.name).sort()).toEqual(["Dana Whitfield", "Olcay Owner", "Sam Porter", "Selin Kaya"]);
    // Readers see whether they read it, not who else did.
    expect(t.wiki.policy(t.sam, p.id)).toMatchObject({ notRead: [], readBy: [], readByMe: null, canRemind: false });

    expect(await t.wiki.remind(t.selin, p.id)).toEqual({ sent: 4, failed: 0 });
    expect(t.sent.map((m) => m.to).sort()).toEqual(["dana@example.com", "owner@example.com", "sam@example.com", "selin@example.com"]);
    expect(t.sent[0]!.text).toContain("https://wiki.example.com/pages/");

    // A small fix keeps the version; a change for readers asks everyone again.
    t.wiki.publish(t.selin, p.id, { baseRevision: 1, html: "<p>Be kind!</p>", notify: "none" });
    expect(t.wiki.policies(t.owner).policies[0]).toMatchObject({ version: 1, read: 1 });
    t.wiki.publish(t.selin, p.id, { baseRevision: 2, html: "<p>Be kind, always.</p>", notify: "everyone" });
    list = t.wiki.policies(t.owner).policies;
    expect(list[0]).toMatchObject({ version: 2, revision: 3, read: 0 });
    expect(t.wiki.get(t.emre, p.id).policy).toMatchObject({ version: 2, readByMe: null });

    const csv = t.wiki.acknowledgementsCsv(t.selin, p.id);
    expect(csv.split("\r\n")[1]).toMatch(/^Code of conduct,People,1,emre@example.com,Emre Aydın,2026-/);
    expect(t.wiki.summary(t.emre).policiesToRead).toBe(1);
  });

  it("count people in Identity's directory who never signed in", () => {
    const t = createTestWiki(SETTINGS.replace("mail:", "identity:\n  url: https://id.example.com\nmail:"));
    const p = t.wiki.create(t.owner, { space: "engineering", title: "On-call", policy: true });
    t.wiki.setDirectory([
      { id: "1", email: "emre@example.com", name: "Emre Aydın", status: "active", groups: ["engineering"] },
      { id: "2", email: "new@example.com", name: "New Person", status: "active", groups: ["engineering"] },
      { id: "3", email: "gone@example.com", name: "Gone", status: "disabled", groups: ["engineering"] },
    ]);
    expect(t.wiki.policy(t.owner, p.id).notRead.map((r) => [r.name, r.signedIn])).toContainEqual(["New Person", false]);
    expect(t.wiki.policy(t.owner, p.id).notRead.map((r) => r.name)).not.toContain("Gone");
  });
});

describe("comments and attachments", () => {
  it("lets readers comment, writers delete their own and editors resolve", () => {
    const t = createTestWiki();
    const p = t.wiki.create(t.selin, { space: "people", title: "Leave" });
    const c = t.wiki.comment(t.emre, p.id, { body: "<b>How many days?</b>" });
    const r = t.wiki.comment(t.selin, p.id, { body: "25.", parent: c.id });
    expect(t.wiki.comments(t.sam, p.id).comments.map((x) => [x.body, x.parent])).toEqual([
      ["<b>How many days?</b>", null],
      ["25.", c.id],
    ]);
    expect(fails(() => t.wiki.resolveComment(t.sam, c.id, { resolved: true })).status).toBe(403);
    expect(t.wiki.resolveComment(t.selin, c.id, { resolved: true }).resolvedBy).toBe("Selin Kaya");
    expect(fails(() => t.wiki.deleteComment(t.emre, r.id)).status).toBe(403);
    t.wiki.deleteComment(t.emre, c.id);
    expect(t.wiki.comments(t.sam, p.id).comments).toEqual([]);
  });

  it("keeps files with the page, for those who can read it", () => {
    const t = createTestWiki();
    const p = t.wiki.create(t.emre, { space: "engineering", title: "Diagram" });
    const a = t.wiki.attach(t.emre, p.id, "../../etc/pipe:line.png", "image/png", Buffer.from("png"));
    expect(a).toMatchObject({ name: "pipe-line.png", type: "image/png", size: 3 });
    t.wiki.publish(t.emre, p.id, { baseRevision: 1, html: `<p><img src="${a.url}" alt="Pipeline"><img src="data:image/svg+xml;base64,PHN2Zz4="></p>` });
    expect(t.wiki.get(t.emre, p.id).html).toBe(`<p><img src="${a.url}" alt="Pipeline" /></p>`);
    expect(t.wiki.attachments(t.emre, p.id).attachments[0]).toMatchObject({ used: true });
    expect(t.wiki.file(t.emre, a.id).data.toString()).toBe("png");
    expect(fails(() => t.wiki.file(t.selin, a.id)).status).toBe(404);
    expect(fails(() => t.wiki.attach(t.emre, p.id, "big.bin", "application/octet-stream", Buffer.alloc(21 * 1024 * 1024))).status).toBe(413);
    t.wiki.detach(t.emre, a.id);
    expect(t.wiki.attachments(t.emre, p.id).attachments).toEqual([]);
  });
});

describe("import", () => {
  it("makes a page of each Markdown or HTML file", () => {
    const t = createTestWiki();
    const r = t.wiki.importFiles(t.emre, {
      space: "engineering",
      format: "markdown",
      files: [
        { name: "on-call.md", content: "---\ntitle: On-call handbook\n---\n\nWho is paged." },
        { name: "paging_rules.md", content: "# Paging rules\n\nAt night, only P1." },
      ],
    });
    expect(r.pages.map((p) => p.title)).toEqual(["On-call handbook", "Paging rules"]);
    const h = t.wiki.importFiles(t.emre, {
      space: "engineering",
      format: "html",
      files: [{ name: "x.html", content: "<title>Old</title><body><h1>Old</h1><p onmouseover=x>Kept</p></body>" }],
    });
    expect(t.wiki.get(t.emre, h.pages[0]!.id)).toMatchObject({ title: "Old", html: "<p>Kept</p>" });
  });
});

describe("the settings file", () => {
  it("warns about spaces with pages that left the file", () => {
    const t = createTestWiki();
    t.wiki.create(t.sam, { space: "sales", title: "Demo script" });
    const next = SETTINGS.replace(/ {2}- key: sales[\s\S]*?editors: \[sales\]\n/, "");
    expect(t.wiki.setConfig(parseConfig(next), next)).toContainEqual(expect.stringContaining("The space sales has 1 pages"));
  });
});
