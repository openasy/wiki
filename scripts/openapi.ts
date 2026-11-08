// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = { type: "object" };
const html = { type: "string", description: "Sanitized HTML: only a page's tags, links to http(s), mailto and the wiki, no script, styles or event handlers." };

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const path = (name: string, what: string) => ({ name, in: "path", required: true, description: what, schema: str });
const id = (what = "page") => [path("id", `The ${what}'s id.`)];
const query = (name: string, description: string, schema: S = str, required = false) => ({ name, in: "query", required, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const file = (type: string, description: string) => ({ description, content: { [type]: { schema: { type: "string", format: "binary" } } } });

/**
 * An operation for anyone signed in (ADR 0003). What they may do in a space comes from its groups and their product
 * role, which the operation checks: `need` says the least role in the page's space.
 */
function op(need: "viewer" | "editor" | "admin" | null, o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": "user",
    ...(need && { "x-openasy-space-role": need }),
    description: [o.description, need && `Needs the ${need} role in the page's space; a page the caller cannot read answers 404.`].filter(Boolean).join("\n\n"),
    responses: { ...(o.requestBody ? { "400": problem } : {}), ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const Person = obj({ email: nul(str), name: str });
const SpaceRole = { type: "string", enum: ["viewer", "editor", "admin"] };
const SpaceRef = obj({ key: str, name: str });
const PageRef = obj({ id: str, title: str });
const Change = obj({
  n: { type: "integer", description: "The page's revision this entry is about." },
  kind: { type: "string", enum: ["create", "edit", "restore", "review", "import", "api"] },
  note: nul(str),
  by: Person,
  at: dt,
  merged: { type: "boolean", description: "Merged with a change published while it was being written." },
});
const Policy = obj({
  version: { type: "integer", description: "Counts the versions people are asked to read; a small fix keeps it." },
  revision: int,
  changedAt: nul(dt),
  due: nul({ ...dt, description: "By when people should have read it: changedAt plus policies.read_within." }),
  readers: { type: "integer", description: "People who can read the space." },
  read: { type: "integer", description: "Of them, how many confirmed this version." },
  readByMe: nul(dt),
});
const Presence = obj({ name: str, email: nul(str), editing: bool, section: nul({ type: "string", description: "The heading the cursor is under." }), at: dt });
const Segment = obj({ text: str, hit: bool });

const Page = obj({
  id: str,
  space: obj({ key: str, name: str, readers: arr(str), editors: arr(str), admins: arr(str) }),
  parent: nul(str),
  ancestors: arr(PageRef),
  title: str,
  html,
  revision: int,
  owner: nul(Person),
  ownerGone: { type: "boolean", description: "No owner, or the owner's account is disabled or left Identity." },
  review: obj({ everyDays: nul(int), reviewedAt: dt, reviewedBy: nul(str), due: nul(dt), overdueDays: nul(int) }),
  policy: nul(Policy),
  isTemplate: bool,
  children: arr(PageRef),
  backlinks: arr(PageRef),
  changes: arr(Change),
  sections: arr(str),
  attachments: int,
  comments: { type: "integer", description: "Open comments." },
  following: bool,
  presence: arr(Presence),
  draft: nul(obj({ base: int, savedAt: dt })),
  views: { type: "integer", description: "Readers in the last 30 days, one a person a day." },
  role: SpaceRole,
  createdAt: dt,
  createdBy: str,
  updatedAt: dt,
  updatedBy: str,
});
const PageSummary = obj({ id: str, title: str, space: SpaceRef, parent: nul(str), excerpt: str, updatedAt: dt, updatedBy: str });
const Comment = obj({ id: str, parent: nul(str), body: str, by: Person, at: dt, resolvedAt: nul(dt), resolvedBy: nul(str), canDelete: bool });
const Attachment = obj({ id: str, name: str, type: str, size: int, url: str, by: str, at: dt });
const notify = {
  type: "string",
  enum: ["none", "followers", "everyone"],
  description:
    "Who is told by email: nobody (a small fix), the page's followers (default) or everyone who can read it. For a policy, anything but none is a new version everyone is asked to read.",
};

const schemas: Record<string, S> = {
  Problem: {
    ...obj(
      {
        type: { type: "string", format: "uri" },
        title: str,
        status: int,
        code: {
          type: "string",
          description: "Stable; match on this.",
          enum: [
            "invalid-token",
            "invalid-json",
            "invalid-body",
            "forbidden-origin",
            "forbidden",
            "not-found",
            "conflict",
            "edit-conflict",
            "payload-too-large",
            "unsupported-media-type",
            "internal-error",
            "unauthenticated",
            "invalid-credentials",
            "mfa-required",
            "mfa-setup-required",
            "cross-site",
          ],
        },
        detail: str,
      },
      ["type", "title", "status", "code"],
    ),
    description: "An edit-conflict problem also carries revision, by, at, titleConflict, conflicts, mine and theirs (see EditConflict).",
  },
  EditConflict: obj({
    revision: { type: "integer", description: "The page's revision now; publish again with it as baseRevision." },
    by: Person,
    at: dt,
    titleConflict: nul(obj({ mine: str, theirs: str })),
    conflicts: arr(obj({ base: arr(str), mine: arr(str), theirs: arr(str) })),
    mine: obj({ title: str, html }),
    theirs: obj({ title: str, html }),
  }),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "wiki" }, version: str }),
  ProductList: obj({ products: arr(obj({ id: str, url: str })) }),
  Summary: obj({
    name: str,
    file: nul(map),
    spaces: int,
    pages: int,
    toReview: { type: "integer", description: "Pages the caller can read that are past their review period." },
    policiesToRead: { type: "integer", description: "Policies whose current version the caller has not confirmed." },
    mail: bool,
  }),
  Me: obj({ name: str, email: nul(str), groups: arr(str), spaces: arr(obj({ key: str, role: SpaceRole })) }),
  Settings: obj({ config: nul(map), yaml: str, file: nul(map), mail: bool, directory: nul(map) }),
  Team: obj({ people: arr(obj({ email: str, name: str })) }),
  SpaceList: obj({
    spaces: arr(
      obj({
        key: str,
        name: str,
        description: nul(str),
        reviewDays: nul(int),
        readers: arr(str),
        editors: arr(str),
        admins: arr(str),
        role: SpaceRole,
        pages: int,
        toReview: int,
      }),
    ),
  }),
  Tree: obj({ space: str, pages: arr(obj({ id: str, title: str, parent: nul(str), position: int, stale: bool, policy: bool, template: bool })) }),
  Page,
  Published: obj({
    page: ref("Page"),
    merged: { type: "boolean", description: "The change was merged with one published after baseRevision." },
    changed: { type: "boolean", description: "false when it was the same as the page already." },
    told: { type: "integer", description: "People sent an email about it." },
  }),
  Changes: obj({ changes: arr(Change) }),
  Revision: { ...obj({ ...Change.properties, title: str, html }) },
  Diff: obj({
    from: int,
    to: int,
    title: obj({ before: str, after: str }),
    changes: arr(
      obj(
        {
          kind: { type: "string", enum: ["same", "added", "removed", "changed"] },
          html,
          words: arr(obj({ text: str, kind: { type: "string", enum: ["same", "added", "removed"] } })),
        },
        ["kind", "html"],
      ),
    ),
  }),
  Draft: obj({ base: int, title: str, html, savedAt: dt }),
  DraftSaved: obj({ base: int, savedAt: dt, revision: int }),
  Presence: obj({ revision: int, lastChange: nul(Change), people: arr(Presence) }),
  Following: obj({ following: bool }),
  Comment,
  Comments: obj({ comments: arr(Comment) }),
  Attachment,
  Attachments: obj({ attachments: arr(obj({ ...Attachment.properties, used: { type: "boolean", description: "The page links to it or shows it." } })) }),
  SearchResults: obj({
    query: str,
    results: arr(obj({ id: str, title: str, space: SpaceRef, path: arr(str), snippet: arr(Segment), policy: bool, updatedAt: dt })),
  }),
  Found: obj({ pages: arr(obj({ id: str, title: str, space: SpaceRef, path: arr(str) })) }),
  Templates: obj({ templates: arr(obj({ id: str, name: str, description: str, html, space: nul(str) })) }),
  Imported: obj({ pages: arr(PageSummary) }),
  Review: obj({
    totals: obj({ pages: int, spaces: int, toReview: int, overdue60: int, ownerGone: int, reviewedThisMonth: int, reviewedLastMonth: int }),
    spaces: arr(obj({ key: str, name: str, reviewDays: nul(int) })),
    pages: arr(obj({ id: str, title: str, space: SpaceRef, owner: nul(Person), ownerGone: bool, reviewedAt: dt, due: nul(dt), overdueDays: int, views: int })),
  }),
  Policies: obj({
    readWithinDays: int,
    mail: bool,
    policies: arr(obj({ id: str, title: str, space: SpaceRef, ...Policy.properties, done: bool, overdue: bool })),
  }),
  PolicyDetail: obj({
    id: str,
    title: str,
    space: SpaceRef,
    ...Policy.properties,
    done: bool,
    overdue: bool,
    notRead: arr(obj({ email: str, name: str, groups: arr(str), signedIn: bool })),
    readBy: arr(obj({ email: str, name: str, at: dt })),
    reminders: arr(obj({ at: dt, sent: int, by: str })),
    canRemind: bool,
  }),
  Reminded: obj({
    sent: { type: "integer", description: "Messages the mail server took." },
    failed: { type: "integer", description: "Messages it refused or could not be reached for." },
  }),
};

const tree = ["/api/v1/spaces/{key}/pages", "/api/v1/spaces/{key}/export"];
const key = [path("key", "The space's key from the file.")];

const paths: Record<string, S> = {
  "/api/v1/version": { get: pub({ operationId: "version", tags: ["Product"], summary: "Product and version", responses: { "200": ok(ref("Version")) } }) },
  "/api/v1/products": {
    get: op(null, { operationId: "products", tags: ["Product"], summary: "The install's other products", responses: { "200": ok(ref("ProductList")) } }),
  },
  "/api/v1/summary": {
    get: op(null, { operationId: "summary", tags: ["Product"], summary: "Counts for the caller's menu", responses: { "200": ok(ref("Summary")) } }),
  },
  "/api/v1/me": {
    get: op(null, { operationId: "me", tags: ["Product"], summary: "The caller's groups and role in each space", responses: { "200": ok(ref("Me")) } }),
  },
  "/api/v1/settings": {
    get: op(null, {
      operationId: "settings",
      tags: ["Product"],
      summary: "The settings file as applied",
      description: "Read-only: the file is the only place they are changed.",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/api/v1/team": {
    get: op(null, {
      operationId: "team",
      tags: ["Product"],
      summary: "The people the wiki knows, for choosing an owner",
      responses: { "200": ok(ref("Team")) },
    }),
  },

  "/api/v1/spaces": {
    get: op(null, {
      operationId: "spaces",
      tags: ["Spaces"],
      summary: "The spaces the caller can read, with their role",
      responses: { "200": ok(ref("SpaceList")) },
    }),
  },
  [tree[0]!]: {
    get: op("viewer", {
      operationId: "spaceTree",
      tags: ["Spaces"],
      summary: "A space's pages, as a tree by parent",
      parameters: key,
      responses: { "200": ok(ref("Tree")), "404": problem },
    }),
  },
  [tree[1]!]: {
    get: op("viewer", {
      operationId: "exportSpace",
      tags: ["Spaces"],
      summary: "A space as a ZIP of Markdown files",
      description: "Pages in folders as in the tree, their files under files/, links between them made relative.",
      parameters: key,
      responses: { "200": file("application/zip", "The ZIP."), "404": problem },
    }),
  },
  "/api/v1/search": {
    get: op(null, {
      operationId: "search",
      tags: ["Search"],
      summary: "Search every page the caller can read",
      description:
        "Full text (SQLite FTS5), every word a prefix; case, accents and the Turkish dotted and dotless i are alike. All words first, any word when none match all.",
      parameters: [query("q", "The words.", str, true), query("space", "Only this space.")],
      responses: { "200": ok(ref("SearchResults")) },
    }),
  },
  "/api/v1/find": {
    get: op(null, {
      operationId: "findPages",
      tags: ["Search"],
      summary: "Pages by title, for links and the search window",
      parameters: [query("q", "Words of the title; empty for the latest.")],
      responses: { "200": ok(ref("Found")) },
    }),
  },
  "/api/v1/templates": {
    get: op(null, { operationId: "templates", tags: ["Pages"], summary: "Templates a new page can start from", responses: { "200": ok(ref("Templates")) } }),
  },
  "/api/v1/import": {
    post: op("editor", {
      operationId: "importPages",
      tags: ["Pages"],
      summary: "Import Markdown or HTML files from another wiki",
      description: "Each file becomes a page under parent. Markdown front matter may give title; otherwise the first # heading or the file name is the title.",
      requestBody: json(
        obj({ space: str, parent: nul(str), format: { type: "string", enum: ["markdown", "html"] }, files: arr(obj({ name: str, content: str })) }, [
          "space",
          "format",
          "files",
        ]),
      ),
      responses: { "201": ok(ref("Imported")), "404": problem, "413": problem, "422": problem },
    }),
  },

  "/api/v1/pages": {
    post: op("editor", {
      operationId: "createPage",
      tags: ["Pages"],
      summary: "Add a page",
      description: "From a template, HTML or Markdown; sanitized before it is stored. Marking it a policy needs the admin role in the space.",
      requestBody: json(
        obj({ space: str, parent: nul(str), title: str, template: str, html: str, markdown: str, policy: bool, isTemplate: bool }, ["space", "title"]),
      ),
      responses: { "201": ok(ref("Page")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/pages/{id}": {
    get: op("viewer", {
      operationId: "getPage",
      tags: ["Pages"],
      summary: "A page, with its owner, review, policy, links, latest changes and who else has it open",
      parameters: [...id(), query("view", "0 to leave it out of the page's readers.")],
      responses: { "200": ok(ref("Page")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updatePage",
      tags: ["Pages"],
      summary: "Move a page, give it an owner, mark it a policy or a template",
      description:
        "Content is changed with publish. owner: the owner or a space admin (anyone when the owner left). policy: space admins. space moves the page and those under it, with the editor role in both.",
      parameters: id(),
      requestBody: json(obj({ owner: nul(str), policy: bool, template: bool, parent: nul(str), position: int, space: str }, [])),
      responses: { "200": ok(ref("Page")), "404": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deletePage",
      tags: ["Pages"],
      summary: "Delete a page with its history",
      description: "Refused while pages are under it. A policy needs the admin role.",
      parameters: id(),
      responses: { "204": { description: "Deleted." }, "404": problem, "409": problem },
    }),
  },
  "/api/v1/pages/{id}/publish": {
    post: op("editor", {
      operationId: "publishPage",
      tags: ["Pages"],
      summary: "Publish a change",
      description:
        "baseRevision is the revision the change started from. When the page has changed since, both changes are merged block by block (paragraphs, headings, lists, tables). When both changed the same or neighbouring blocks, nothing is published: 409 edit-conflict carries both versions to choose from, and the revision to publish against.",
      parameters: id(),
      requestBody: json(obj({ baseRevision: int, title: str, html: str, markdown: str, note: str, notify }, ["baseRevision"])),
      responses: { "200": ok(ref("Published")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/pages/{id}/review": {
    post: op("editor", {
      operationId: "reviewPage",
      tags: ["Review"],
      summary: "Mark a page reviewed: it is still right",
      parameters: id(),
      requestBody: { required: false, content: { "application/json": { schema: obj({ note: str }, []) } } },
      responses: { "200": ok(ref("Page")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/pages/{id}/revisions": {
    get: op("viewer", {
      operationId: "pageRevisions",
      tags: ["History"],
      summary: "Every change, newest first",
      parameters: id(),
      responses: { "200": ok(ref("Changes")), "404": problem },
    }),
  },
  "/api/v1/pages/{id}/revisions/{n}": {
    get: op("viewer", {
      operationId: "pageRevision",
      tags: ["History"],
      summary: "A revision as it was",
      parameters: [...id(), path("n", "The revision.")],
      responses: { "200": ok(ref("Revision")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/pages/{id}/revisions/{n}/restore": {
    post: op("editor", {
      operationId: "restoreRevision",
      tags: ["History"],
      summary: "Publish an old revision again",
      description: "A new revision with the old words; nothing is lost.",
      parameters: [...id(), path("n", "The revision.")],
      responses: { "200": ok(ref("Published")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/pages/{id}/diff": {
    get: op("viewer", {
      operationId: "pageDiff",
      tags: ["History"],
      summary: "What changed between two revisions, block by block",
      parameters: [...id(), query("from", "The earlier revision; 0 for an empty page.", int, true), query("to", "The later revision.", int, true)],
      responses: { "200": ok(ref("Diff")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/pages/{id}/draft": {
    get: op("editor", {
      operationId: "getDraft",
      tags: ["Editing"],
      summary: "The caller's unpublished draft",
      parameters: id(),
      responses: { "200": ok(ref("Draft")), "404": problem },
    }),
    put: op("editor", {
      operationId: "saveDraft",
      tags: ["Editing"],
      summary: "Save the caller's draft as they write",
      parameters: id(),
      requestBody: json(obj({ base: int, title: str, html: str })),
      responses: { "200": ok(ref("DraftSaved")), "404": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "dropDraft",
      tags: ["Editing"],
      summary: "Throw the draft away",
      parameters: id(),
      responses: { "204": { description: "Gone." }, "404": problem },
    }),
  },
  "/api/v1/pages/{id}/presence": {
    post: op("viewer", {
      operationId: "presence",
      tags: ["Editing"],
      summary: "Say the caller has the page open, and whether and where they edit; answers who else has",
      description: "Sent every few seconds while the page is open; someone not heard from for 30 seconds has left. leave: true says so at once.",
      parameters: id(),
      requestBody: json(obj({ editing: bool, section: nul(str), leave: bool }, [])),
      responses: { "200": ok(ref("Presence")), "404": problem },
    }),
  },
  "/api/v1/pages/{id}/follow": {
    put: op("viewer", {
      operationId: "follow",
      tags: ["Pages"],
      summary: "Follow a page: be told by email when it changes",
      parameters: id(),
      responses: { "200": ok(ref("Following")), "404": problem },
    }),
    delete: op("viewer", {
      operationId: "unfollow",
      tags: ["Pages"],
      summary: "Stop following a page",
      parameters: id(),
      responses: { "200": ok(ref("Following")), "404": problem },
    }),
  },
  "/api/v1/pages/{id}/export": {
    get: op("viewer", {
      operationId: "exportPage",
      tags: ["Pages"],
      summary: "A page as Markdown or one HTML file",
      parameters: [...id(), query("format", "markdown (default) or html.")],
      responses: {
        "200": { description: "The file.", content: { "text/markdown": { schema: str }, "text/html": { schema: str } } },
        "404": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/pages/{id}/comments": {
    get: op("viewer", {
      operationId: "comments",
      tags: ["Comments"],
      summary: "A page's comments",
      parameters: id(),
      responses: { "200": ok(ref("Comments")), "404": problem },
    }),
    post: op("viewer", {
      operationId: "addComment",
      tags: ["Comments"],
      summary: "Comment on a page, or answer a comment",
      description: "Plain text. Everyone who can read the page may comment.",
      parameters: id(),
      requestBody: json(obj({ body: str, parent: nul(str) }, ["body"])),
      responses: { "201": ok(ref("Comment")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/comments/{id}": {
    patch: op("viewer", {
      operationId: "resolveComment",
      tags: ["Comments"],
      summary: "Resolve a comment, or open it again",
      description: "The space's editors and the comment's writer.",
      parameters: id("comment"),
      requestBody: json(obj({ resolved: bool })),
      responses: { "200": ok(ref("Comment")), "404": problem, "422": problem },
    }),
    delete: op("viewer", {
      operationId: "deleteComment",
      tags: ["Comments"],
      summary: "Delete a comment and its answers",
      description: "Its writer, or an admin of the space.",
      parameters: id("comment"),
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },
  "/api/v1/pages/{id}/attachments": {
    get: op("viewer", {
      operationId: "attachments",
      tags: ["Attachments"],
      summary: "A page's files",
      parameters: id(),
      responses: { "200": ok(ref("Attachments")), "404": problem },
    }),
    post: op("editor", {
      operationId: "attach",
      tags: ["Attachments"],
      summary: "Add a file or image to a page",
      description: "The file is the body, with its own Content-Type; at most attachments.max_size.",
      parameters: [...id(), query("name", "The file's name.", str, true)],
      requestBody: { required: true, content: { "*/*": { schema: { type: "string", format: "binary" } } } },
      responses: { "201": ok(ref("Attachment")), "404": problem, "413": problem, "415": problem, "422": problem },
    }),
  },
  "/api/v1/attachments/{id}": {
    get: op("viewer", {
      operationId: "attachment",
      tags: ["Attachments"],
      summary: "A file",
      description:
        "PNG, JPEG, GIF, WebP and AVIF images are shown; every other type is downloaded as application/octet-stream. Each is sent with a sandbox content security policy, so even a file a browser opens runs nothing.",
      parameters: id("file"),
      responses: { "200": file("application/octet-stream", "The file."), "404": problem },
    }),
    delete: op("editor", {
      operationId: "deleteAttachment",
      tags: ["Attachments"],
      summary: "Delete a file",
      parameters: id("file"),
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },
  "/api/v1/attachments/{id}/{name}": {
    get: op("viewer", {
      operationId: "attachmentNamed",
      tags: ["Attachments"],
      summary: "A file, at an address that ends in its name",
      parameters: [...id("file"), path("name", "The file's name; not checked.")],
      responses: { "200": file("application/octet-stream", "The file."), "404": problem },
    }),
  },

  "/api/v1/review": {
    get: op(null, {
      operationId: "toReview",
      tags: ["Review"],
      summary: "Pages past their space's review period, the most read and longest overdue first",
      responses: { "200": ok(ref("Review")) },
    }),
  },
  "/api/v1/policies": {
    get: op(null, {
      operationId: "policies",
      tags: ["Policies"],
      summary: "Policies and how many have read their current version",
      responses: { "200": ok(ref("Policies")) },
    }),
  },
  "/api/v1/policies/{id}": {
    get: op("viewer", {
      operationId: "policy",
      tags: ["Policies"],
      summary: "A policy, and who has and has not read its current version",
      description: "The lists of people are for the space's editors; others get them empty.",
      parameters: id(),
      responses: { "200": ok(ref("PolicyDetail")), "404": problem },
    }),
  },
  "/api/v1/policies/{id}/acknowledge": {
    post: op("viewer", {
      operationId: "acknowledge",
      tags: ["Policies"],
      summary: "Confirm the caller has read this version",
      description: "version must be the current one, so nobody confirms words they did not see.",
      parameters: id(),
      requestBody: json(obj({ version: int })),
      responses: { "200": ok(ref("Page")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/policies/{id}/remind": {
    post: op("editor", {
      operationId: "remind",
      tags: ["Policies"],
      summary: "Email everyone who has not read the current version",
      description: "Answers once the mail server has taken or refused each message.",
      parameters: id(),
      responses: { "200": ok(ref("Reminded")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/policies/{id}/acknowledgements": {
    get: op("editor", {
      operationId: "acknowledgements",
      tags: ["Policies"],
      summary: "Every confirmation of every version, as CSV, for Compliance",
      parameters: id(),
      responses: { "200": { description: "CSV.", content: { "text/csv": { schema: str } } }, "404": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Wiki",
    version,
    description:
      "The company's handbook: spaces from wiki.yaml, pages with every change kept, the search, reviews and policies people confirm they have read. Anyone signed in may call it; what they read, write and manage in each space follows the space's groups, with the product role as a floor (owners and admins manage every space, editors edit and viewers read every space).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens; it acts in every space with its role." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
