# wiki

[![CI](https://github.com/openasy/wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/wiki/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Wiki product: the company's own handbook and how-tos, in spaces by team,
written together in the browser, searchable, with an owner and a review date on every page, and policies people
confirm they have read. Customer help lives in the Knowledge Base, not here.

```
wiki.yaml ──▶ spaces, and who reads, edits and manages each one (Identity groups)
people ──▶ pages (every change kept, merged when two edit at once) ──▶ search, links both ways, comments
owners ──▶ pages past their space's review period          policies ──▶ who has not read the current version
```

## Pages

- **Spaces** come from `wiki.yaml`, one per team or topic, each with the Identity groups that read, edit and manage it
  and how often its pages are reviewed. Pages nest under pages, in an order people choose, and move between spaces
  with the pages under them.
- **The editor** is [TipTap](https://tiptap.dev) (ProseMirror, MIT): headings, lists, quotes, tables, code, images
  and files (pasted, dropped or picked), links to other pages and other products, a toolbar and a `/` menu. A draft is
  kept on the server as one writes, so a closed tab loses nothing.
- **Templates:** how-to, policy, runbook, meeting notes, onboarding and decision record come with the wiki; any page
  marked as a template is offered in its space too. Their words are English, to be replaced.
- **Links** to other pages are kept both ways: every page lists the pages that link to it.
- **History:** every published change is kept with who made it and a note on what changed. Any two revisions are
  compared block by block, with the words changed marked; an earlier revision can be published again.
- **Comments:** everyone who can read a page comments and answers; editors and the writer resolve.
- **Import** takes Markdown (front matter `title`, else the first `#` heading or the file name) and HTML files from
  another wiki. **Export** gives a page as Markdown or one HTML file, and a space as a ZIP of Markdown files in the
  tree's folders with their files, links between them made relative.

### Two people on one page

Each edit starts from a revision, and publishing names it (`baseRevision`). When the page has changed since, the two
changes are merged block by block (paragraphs, headings, lists, tables, code) against the revision both started from,
a three-way merge. Changes to different blocks are both kept, and the history says the revision was merged. When both
changed the same blocks or ones next to each other, nothing is published: the editor shows both versions of those
blocks, the person chooses one, checks it and publishes again. Nothing is overwritten unseen, also by the API.

While a page is open, who else has it open, and who is editing in which section, is shown beside it (sent every few
seconds, gone after 30 seconds of silence), and the editor says when someone published while you wrote.

This is not live co-editing with both cursors in one document (Yjs): that needs a WebSocket service and keeping
CRDT state beside the sanitized HTML, and the product story puts it after the first release.

### Sanitizing and files

Every body is sanitized with [sanitize-html](https://github.com/apostrophecms/sanitize-html) before it is stored
(from the editor, the API, import and drafts) and again when it is sent. Only a page's tags are kept; `class` only as
`language-*` on code. Links go to http(s), mailto and paths; external ones get `rel="noopener noreferrer nofollow"`.
Images come from http(s) or the wiki's own files; data URLs, SVG, scripts, styles, frames, forms and every event
handler are removed. The UI's Content-Security-Policy runs no inline script.

Files are kept in the database with the page and served only to those who can read it. PNG, JPEG, GIF, WebP and AVIF
are shown; every other type, SVG and HTML included, is downloaded as `application/octet-stream`. Each is sent with
`Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`.

## Who may do what

Each space's `readers`, `editors` and `admins` are Identity groups, by the name the groups claim carries; `everyone`
is every member. The groups come with each sign-in through Identity or another OIDC provider (`onOidcSignIn`), from
Identity's directory when `identity` is set, and from the file's `groups` for people who sign in with a password.

| | In a space |
| --- | --- |
| Reader | Reads, searches, comments, follows, confirms policies |
| Editor | Also writes, publishes, imports, moves, reviews, uploads files, sends policy reminders, sees who has read a policy |
| Admin | Also marks and unmarks policies, deletes them and others' comments |

The product role from @openasy/auth is a floor in every space: owners and admins manage every space, editors edit
and viewers read every space. People with the `user` role (the default for newcomers through Identity) get only what
their groups give. API tokens have no groups: a token acts in every space with its role. A page in a space someone
cannot read answers 404, and the search, the tree, links and backlinks leave it out.

## Search

SQLite FTS5 over each page's title and words, folded: lowercase, without accents, and with the Turkish dotted and
dotless i alike, so `sifre` finds `Şifre` and `IZIN` finds `izin`. Every word is a prefix; pages with all the words
first, any of them when none has all. Titles weigh more. Results show the words around the first match, marked, and
only pages in spaces the person can read. The search window (Cmd+K) uses the same search.

## Keeping it current

A page not reviewed within its space's `review` period is listed under **To review**, the most read and longest
overdue first, with its owner; pages whose owner left (disabled, or gone from Identity's directory) or that have none
are counted to be given a new owner. "Still right" marks a review without a change, and it shows in the history.

## Policies

An admin of a space marks a page as a policy. Everyone who can read the space is asked to confirm, at the end of the
page, that they have read the current version, within `policies.read_within`. A change published with "tell readers"
is a new version and asks everyone again; a small fix ("nobody") keeps the version. **Policies** shows each policy,
how many have read its current version and by when; the space's editors see who has not, can remind them by email,
and download every confirmation of every version as CSV for Compliance. With Identity's directory, people who never
opened the wiki are counted too.

## The settings file

`/config/wiki.yaml` (`WIKI_CONFIG`), as in [config/wiki.yaml](./config/wiki.yaml). No screen and no API route changes
it. It is read at start and within a minute of a change, and applied whole or not at all: a file with a mistake
leaves the last good version in place, and the log and the Settings page say which field to fix. Without a file, the
wiki starts with one space, General, everyone may read and edit. A space taken out of the file keeps its pages, unseen
until it is put back.

| Field | Default | |
| --- | --- | --- |
| `wiki.name` | `Wiki` | |
| `wiki.review` | `12 months` | The review period of spaces that set none |
| `spaces[].key`, `name`, `description` | | The key is in addresses and the API |
| `spaces[].review` | `wiki.review` | `90 days`, `6 months`, `1 year` or `never` |
| `spaces[].readers`, `editors`, `admins` | | Group names; `everyone` is every member |
| `policies.read_within` | `14 days` | How long people have to read a new version |
| `groups` | | `group: [email, ...]` for people without a provider's groups |
| `attachments.max_size` | `20 MB` | The largest file |
| `mail` | | `host`, `port`, `security` (`starttls`, `tls`, `none`), `user`, `password` (a variable's name), `from` |
| `identity` | | `url` and `token` (a variable's name): Identity's directory, read every 15 minutes |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/wiki.yaml
docker compose up -d
docker compose logs wiki | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WIKI_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; links in mail use it |
| `WIKI_CONFIG` | `/config/wiki.yaml` | The settings file |
| `WIKI_SMTP_PASSWORD`, `WIKI_IDENTITY_TOKEN` | | The secrets the file names, by these default names |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `WIKI_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `WIKI_DB` | `/data/wiki.db` | SQLite file (WAL), on the `/data` volume: pages, revisions, files, comments, confirmations |
| `WIKI_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `WIKI_HEADLESS` | `false` | `true` serves no UI; the API stays |
| `WIKI_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Presence
calls are not written to the request log.

## API

The UI uses the same API. The reference is served at `/api/docs/`, and `openapi.json` is written by
`npm run openapi` from `scripts/openapi.ts`; a test fails when it is out of date, and every response of every
operation is checked against it. Pages from your own tools, such as generated documentation:

```bash
curl -X POST https://wiki.example.com/api/v1/pages -H "authorization: Bearer $WIKI_TOKEN" \
  -H "content-type: application/json" -d '{"space":"engineering","title":"API reference","markdown":"# ..."}'
curl -X POST https://wiki.example.com/api/v1/pages/<id>/publish -H "authorization: Bearer $WIKI_TOKEN" \
  -H "content-type: application/json" -d '{"baseRevision":3,"markdown":"...","note":"From v4.19","notify":"none"}'
```

## Develop

```bash
npm install
npm test        # settings, sanitizing, Markdown, the merge, permissions, search, review, policies, SMTP, ZIP, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

The UI follows the Wiki screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only Settings page is
rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a published
`@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
