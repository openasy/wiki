// Reading: the spaces' tree, a page with its owner, review date and changes, comments, a policy's "I have read it",
// the history with what changed, and the search.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  IconButton,
  navigate,
  PageHeader,
  Panel,
  SearchInput,
  SelectField,
  StatusBadge,
  TextField,
  useAgo,
} from "@openasy/ui";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileCheck,
  FileText,
  FolderInput,
  History,
  LayoutTemplate,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Change, Comment, DiffChange, Found, Page, Published, SearchResult, Space, Template, TreePage } from "./api.ts";
import { groupsText, PageBody, period, useLoad, when } from "./common.tsx";
import { useWiki, writable } from "./context.tsx";
import { useT, type T } from "./i18n.ts";

// ---------------------------------------------------------------- The tree

function SpaceTree({ space, active }: { space: Space; active: Page | null | undefined }) {
  const t = useT();
  const { call, version } = useWiki();
  const [tree] = useLoad<{ pages: TreePage[] }>(call, `/api/v1/spaces/${space.key}/pages?v=${version}`);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const kids = useMemo(() => {
    const m = new Map<string | null, TreePage[]>();
    for (const p of tree?.pages ?? []) m.set(p.parent, [...(m.get(p.parent) ?? []), p]);
    return m;
  }, [tree]);
  const onPath = new Set([...(active?.ancestors.map((a) => a.id) ?? []), ...(active ? [active.id] : [])]);
  const node = (p: TreePage, depth: number) => {
    const children = kids.get(p.id) ?? [];
    const expanded = open[p.id] ?? onPath.has(p.id);
    const current = active?.id === p.id;
    return (
      <li key={p.id}>
        <div className={`wiki-tree-row ${depth ? "wiki-tree-child" : ""} ${current ? "wiki-tree-current" : ""}`}>
          {children.length ? (
            <button
              type="button"
              className="wiki-tree-toggle"
              aria-expanded={expanded}
              aria-label={t(expanded ? "tree.collapse" : "tree.expand", { title: p.title })}
              onClick={() => setOpen((o) => ({ ...o, [p.id]: !expanded }))}
            >
              {expanded ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
            </button>
          ) : (
            <span aria-hidden className="wiki-tree-toggle" />
          )}
          <a href={`/pages/${p.id}`} aria-current={current ? "page" : undefined} className="wiki-tree-link">
            <span className="truncate">{p.title}</span>
            {p.policy && <FileCheck aria-label={t("tree.policy")} className="size-3 shrink-0 text-fg-muted" />}
            {p.stale && <Clock aria-label={t("tree.stale")} className="wiki-tree-stale size-3 shrink-0 text-warning-text" />}
          </a>
        </div>
        {children.length > 0 && expanded && <ul className="wiki-tree-list wiki-tree-nested">{children.map((c) => node(c, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <div className="wiki-tree-space">
      <span className="wiki-tree-space-name">
        <a href={`/spaces/${space.key}`} className="truncate">
          {space.name}
        </a>
        <span className="font-mono">{space.readers.includes("everyone") ? "everyone" : space.readers.join(", ")}</span>
      </span>
      {tree === undefined ? (
        <p className="wiki-tree-empty">…</p>
      ) : (kids.get(null) ?? []).length ? (
        <ul className="wiki-tree-list">{(kids.get(null) ?? []).map((p) => node(p, 0))}</ul>
      ) : (
        <p className="wiki-tree-empty">{t("tree.empty")}</p>
      )}
    </div>
  );
}

export function Tree({ active }: { active?: Page | null }) {
  const t = useT();
  const { spaces } = useWiki();
  const [q, setQ] = useState("");
  return (
    <Panel flush aria-label={t("tree.region")} className="wiki-tree self-start">
      <form
        className="wiki-tree-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <SearchInput label={t("tree.search")} placeholder={t("tree.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      {spaces.map((s) => (
        <SpaceTree key={s.key} space={s} active={active} />
      ))}
    </Panel>
  );
}

// ---------------------------------------------------------------- Dialogs

/** A new page: where it goes, its title and what it starts from. */
export function NewPageDialog({
  open,
  onOpenChange,
  space,
  parent,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  space?: string;
  parent?: Page | null;
}) {
  const t = useT();
  const { call, spaces, changed } = useWiki();
  const mine = writable(spaces);
  const [title, setTitle] = useState("");
  const [where, setWhere] = useState(parent?.space.key ?? space ?? mine[0]?.key ?? "");
  const [under, setUnder] = useState<string>(parent?.id ?? "");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [templates] = useLoad<{ templates: Template[] }>(call, open ? "/api/v1/templates" : null);
  const [tree] = useLoad<{ pages: TreePage[] }>(call, open && where ? `/api/v1/spaces/${where}/pages` : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void call<Page>("/api/v1/pages", {
      method: "POST",
      body: JSON.stringify({ space: where, parent: under || null, title, ...(template && { template }) }),
    }).then(
      (p) => {
        onOpenChange(false);
        changed();
        navigate(`/pages/${p.id}/edit`);
      },
      (err: Error) => setError(err.message),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("newPage.title")}
      description={t("newPage.description")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || !where}>
            {t("newPage.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && (
          <Callout tone="danger" title={t("common.failed")}>
            {error}
          </Callout>
        )}
        <TextField label={t("newPage.name")} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
        <SelectField
          label={t("newPage.space")}
          value={where}
          onChange={(e) => (setWhere(e.target.value), setUnder(""))}
          options={mine.map((s) => ({ value: s.key, label: s.name }))}
        />
        <SelectField
          label={t("newPage.under")}
          value={under}
          onChange={(e) => setUnder(e.target.value)}
          options={[{ value: "", label: t("newPage.top") }, ...(tree?.pages ?? []).map((p) => ({ value: p.id, label: p.title }))]}
        />
        <SelectField
          label={t("newPage.template")}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          options={[
            { value: "", label: t("newPage.blank") },
            ...(templates?.templates ?? [])
              .filter((x) => !x.space || x.space === where)
              .map((x) => ({ value: x.id, label: x.space ? `${x.name} (${t("newPage.fromSpace")})` : x.name })),
          ]}
        />
        {template && <p className="text-xs text-fg-muted">{templates?.templates.find((x) => x.id === template)?.description}</p>}
      </div>
    </Dialog>
  );
}

function MoveDialog({ page, open, onOpenChange, onDone }: { page: Page; open: boolean; onOpenChange: (o: boolean) => void; onDone: (p: Page) => void }) {
  const t = useT();
  const { call, spaces } = useWiki();
  const [space, setSpace] = useState(page.space.key);
  const [parent, setParent] = useState(page.parent ?? "");
  const [error, setError] = useState<string | null>(null);
  const [tree] = useLoad<{ pages: TreePage[] }>(call, open ? `/api/v1/spaces/${space}/pages` : null);
  // Not under itself or one of its own pages.
  const below = useMemo(() => {
    const out = new Set([page.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of tree?.pages ?? []) if (p.parent && out.has(p.parent) && !out.has(p.id)) (out.add(p.id), (grew = true));
    }
    return out;
  }, [tree, page.id]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("move.title", { title: page.title })}
      description={t("move.description")}
      onSubmit={(e) => {
        e.preventDefault();
        void call<Page>(`/api/v1/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ space, parent: parent || null }) }).then(
          (p) => (onOpenChange(false), onDone(p)),
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("move.move")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && (
          <Callout tone="danger" title={t("common.failed")}>
            {error}
          </Callout>
        )}
        <SelectField
          label={t("newPage.space")}
          value={space}
          onChange={(e) => (setSpace(e.target.value), setParent(""))}
          options={writable(spaces).map((s) => ({ value: s.key, label: s.name }))}
        />
        <SelectField
          label={t("newPage.under")}
          value={parent}
          onChange={(e) => setParent(e.target.value)}
          options={[
            { value: "", label: t("newPage.top") },
            ...(tree?.pages ?? []).filter((p) => !below.has(p.id)).map((p) => ({ value: p.id, label: p.title })),
          ]}
        />
      </div>
    </Dialog>
  );
}

function OwnerDialog({ page, open, onOpenChange, onDone }: { page: Page; open: boolean; onOpenChange: (o: boolean) => void; onDone: (p: Page) => void }) {
  const t = useT();
  const { call } = useWiki();
  const [team] = useLoad<{ people: Array<{ email: string; name: string }> }>(call, open ? "/api/v1/team" : null);
  const [owner, setOwner] = useState(page.owner?.email ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("owner.title")}
      description={t("owner.description")}
      onSubmit={(e) => {
        e.preventDefault();
        void call<Page>(`/api/v1/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ owner: owner || null }) }).then(
          (p) => (onOpenChange(false), onDone(p)),
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("common.save")}
          </Button>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5">
          {error}
        </Callout>
      )}
      <SelectField
        label={t("about.owner")}
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        options={[{ value: "", label: t("owner.nobody") }, ...(team?.people ?? []).map((p) => ({ value: p.email, label: `${p.name} (${p.email})` }))]}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------- A page

export function reviewBadge(page: Page, t: T, ago: (iso: string) => string) {
  if (page.review.overdueDays !== null)
    return <StatusBadge tone={page.review.overdueDays > 60 ? "danger" : "warning"}>{t("page.reviewOverdue", { count: page.review.overdueDays })}</StatusBadge>;
  return <StatusBadge tone="success">{t("page.reviewed", { when: ago(page.review.reviewedAt) })}</StatusBadge>;
}

function changeText(c: Change, t: T) {
  return c.note ?? t(`change.${c.kind}`);
}

export function ChangeList({ changes, label }: { changes: Change[]; label: string }) {
  const t = useT();
  return (
    <ol aria-label={label} className="wiki-list flex flex-col gap-2">
      {changes.map((c, i) => (
        <li key={`${c.n}-${c.kind}-${i}`} className="flex gap-2 text-xs">
          <Avatar name={c.by.name} size="sm" className="size-5" />
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">
              {changeText(c, t)}
              {c.merged && <span className="text-fg-muted"> · {t("change.merged")}</span>}
            </span>
            <span className="text-2xs text-fg-muted">
              {c.by.name} · {when(c.at, t)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function PolicyBox({ page, onDone }: { page: Page; onDone: (p: Page) => void }) {
  const t = useT();
  const ago = useAgo();
  const { call, changed } = useWiki();
  const [error, setError] = useState<string | null>(null);
  const p = page.policy!;
  return (
    <section aria-label={t("policy.region")} className="wiki-policy-box mt-3 rounded-md border border-line px-3 py-2.5">
      {p.readByMe ? (
        <p className="flex items-center gap-2 text-sm text-fg">
          <FileCheck aria-hidden className="size-4 text-success" />
          {t("policy.youRead", { version: p.version, when: ago(p.readByMe) })}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg">{t("policy.askRead", { version: p.version })}</p>
          {p.due && <p className="text-xs text-fg-muted">{t("policy.readBy", { date: when(p.due, t) })}</p>}
          {error && (
            <Callout tone="danger" title={t("common.failed")}>
              {error}
            </Callout>
          )}
          <div>
            <Button
              variant="primary"
              icon={<FileCheck />}
              onClick={() =>
                void call<Page>(`/api/v1/policies/${page.id}/acknowledge`, { method: "POST", body: JSON.stringify({ version: p.version }) }).then(
                  (r) => (onDone(r), changed()),
                  (err: Error) => setError(err.message),
                )
              }
            >
              {t("policy.iHaveRead")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Comments({ page }: { page: Page }) {
  const t = useT();
  const { call } = useWiki();
  const [data, reload] = useLoad<{ comments: Comment[] }>(call, `/api/v1/pages/${page.id}/comments`);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<{ to: string; text: string } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const all = data?.comments ?? [];
  const roots = all.filter((c) => !c.parent && (showResolved || !c.resolvedAt));
  const resolved = all.filter((c) => !c.parent && c.resolvedAt).length;
  const canResolve = page.role !== "viewer";
  const post = (body: string, parent: string | null) =>
    void call(`/api/v1/pages/${page.id}/comments`, { method: "POST", body: JSON.stringify({ body, parent }) }).then(() => {
      setText("");
      setReply(null);
      reload();
    });
  const one = (c: Comment) => (
    <div className="flex gap-2">
      <Avatar name={c.by.name} size="sm" className="size-5" />
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-2xs text-fg-muted">
          <span className="font-medium text-fg">{c.by.name}</span> · {when(c.at, t)}
          {c.resolvedAt && ` · ${t("comments.resolvedBy", { name: c.resolvedBy ?? "" })}`}
        </span>
        <p className="wiki-comment-body text-sm text-fg">{c.body}</p>
      </div>
      {c.canDelete && (
        <IconButton size="sm" label={t("comments.delete")} onClick={() => void call(`/api/v1/comments/${c.id}`, { method: "DELETE" }).then(reload)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
  return (
    <Panel
      title={t("comments.title")}
      aria-label={t("comments.title")}
      actions={
        resolved > 0 && (
          <Button size="xs" variant="ghost" onClick={() => setShowResolved((s) => !s)}>
            {showResolved ? t("comments.hideResolved") : t("comments.showResolved", { count: resolved })}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {roots.length === 0 && <p className="text-sm text-fg-muted">{t("comments.none")}</p>}
        {roots.map((c) => (
          <article key={c.id} className={`wiki-comment flex flex-col gap-2 ${c.resolvedAt ? "wiki-resolved" : ""}`}>
            {one(c)}
            {all
              .filter((r) => r.parent === c.id)
              .map((r) => (
                <div key={r.id} className="wiki-reply">
                  {one(r)}
                </div>
              ))}
            <div className="wiki-reply flex flex-wrap gap-1">
              {reply?.to === c.id ? (
                <form
                  className="flex w-full flex-col gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (reply.text.trim()) post(reply.text, c.id);
                  }}
                >
                  <TextField label={t("comments.reply")} value={reply.text} maxLength={4000} onChange={(e) => setReply({ to: c.id, text: e.target.value })} />
                  <div className="flex gap-1">
                    <Button size="xs" type="submit" variant="primary">
                      {t("comments.send")}
                    </Button>
                    <Button size="xs" type="button" onClick={() => setReply(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <Button size="xs" variant="ghost" onClick={() => setReply({ to: c.id, text: "" })}>
                    {t("comments.reply")}
                  </Button>
                  {(canResolve || c.canDelete) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void call(`/api/v1/comments/${c.id}`, { method: "PATCH", body: JSON.stringify({ resolved: !c.resolvedAt }) }).then(reload)}
                    >
                      {c.resolvedAt ? t("comments.reopen") : t("comments.resolve")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </article>
        ))}
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) post(text, null);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-fg">
            {t("comments.add")}
            <textarea className="wiki-textarea" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div>
            <Button size="sm" type="submit" icon={<MessageSquare />} disabled={!text.trim()}>
              {t("comments.send")}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}

/** One page as people read it: the space's tree, the page, and its owner, review date and history beside it. */
export function PageView({ id }: { id: string }) {
  const t = useT();
  const ago = useAgo();
  const { call, changed, say } = useWiki();
  const [page, reload, setPage] = useLoad<Page>(call, `/api/v1/pages/${id}`);
  const [newOpen, setNewOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [owning, setOwning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Who else has it open, every 15 seconds.
  const [here, setHere] = useState<Page["presence"]>([]);
  useEffect(() => {
    let live = true;
    const ping = () =>
      void call<{ people: Page["presence"] }>(`/api/v1/pages/${id}/presence`, { method: "POST", body: JSON.stringify({ editing: false }) }).then(
        (r) => live && setHere(r.people),
        () => {},
      );
    ping();
    const timer = setInterval(ping, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
      void call(`/api/v1/pages/${id}/presence`, { method: "POST", body: JSON.stringify({ leave: true }) }).catch(() => {});
    };
  }, [call, id]);

  if (page === null)
    return (
      <div className="wiki-page-grid grid gap-2.5">
        <Tree />
        <EmptyState title={t("page.notFound")}>{t("page.notFoundDetail")}</EmptyState>
      </div>
    );
  if (!page) return <PageHeader title={t("loading")} />;
  const canEdit = page.role !== "viewer";
  const isAdmin = page.role === "admin";
  const update = (p: Page) => (setPage(p), changed());
  const patch = (body: unknown, message: string) =>
    void call<Page>(`/api/v1/pages/${page.id}`, { method: "PATCH", body: JSON.stringify(body) }).then(
      (p) => (update(p), say(message)),
      (err: Error) => setError(err.message),
    );
  const editing = here.filter((h) => h.editing);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: page.space.name, href: `/spaces/${page.space.key}` },
          ...page.ancestors.map((a) => ({ label: a.title, href: `/pages/${a.id}` })),
          { label: page.title },
        ]}
        title={page.title}
        meta={
          <>
            {reviewBadge(page, t, ago)}
            {page.policy && <Badge tone="info">{t("page.policyVersion", { version: page.policy.version })}</Badge>}
            {page.isTemplate && <Badge>{t("page.template")}</Badge>}
          </>
        }
        actions={
          canEdit && (
            <>
              <Button icon={<Plus />} onClick={() => setNewOpen(true)}>
                {t("page.new")}
              </Button>
              <Button variant="primary" icon={<Pencil />} onClick={() => navigate(`/pages/${page.id}/edit`)}>
                {t("page.edit")}
              </Button>
            </>
          )
        }
      />
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}
      {page.draft && canEdit && (
        <Callout
          tone="info"
          title={t("page.draftTitle", { when: ago(page.draft.savedAt) })}
          className="mb-2.5"
          action={
            <Button size="sm" onClick={() => navigate(`/pages/${page.id}/edit`)}>
              {t("page.draftOpen")}
            </Button>
          }
        >
          {t("page.draftDetail")}
        </Callout>
      )}
      <div className="wiki-page-grid grid gap-2.5">
        <Tree active={page} />
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel aria-label={t("page.region")}>
            {page.html ? (
              <PageBody html={page.html} className="wiki-measure text-sm leading-relaxed text-fg" />
            ) : (
              <EmptyState title={t("page.empty")} action={canEdit && <Button onClick={() => navigate(`/pages/${page.id}/edit`)}>{t("page.write")}</Button>} />
            )}
            {page.children.length > 0 && (
              <nav aria-label={t("page.children")} className="wiki-children mt-3 border-t border-line pt-2.5">
                <h2 className="mb-1 text-xs font-semibold text-fg-muted">{t("page.children")}</h2>
                <ul className="wiki-list flex flex-col gap-1">
                  {page.children.map((c) => (
                    <li key={c.id}>
                      <a href={`/pages/${c.id}`} className="flex items-center gap-1.5 text-sm">
                        <FileText aria-hidden className="size-3.5 text-fg-muted" />
                        {c.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            {page.policy && <PolicyBox page={page} onDone={setPage} />}
          </Panel>
          <Comments page={page} />
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          {editing.length > 0 && (
            <Callout tone="info" title={t("here.editing", { names: editing.map((h) => h.name).join(", "), count: editing.length })}>
              {editing.some((h) => h.section) ? t("here.inSection", { section: editing.find((h) => h.section)!.section! }) : t("here.editingDetail")}
            </Callout>
          )}
          <Panel title={t("about.title")}>
            <dl className="wiki-facts grid gap-x-2 gap-y-1.5 text-xs">
              <dt className="text-fg-muted">{t("about.owner")}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-fg">
                {page.owner ? (
                  <>
                    <Avatar name={page.owner.name} size="sm" className="size-5" />
                    <span className="truncate">{page.owner.name}</span>
                  </>
                ) : (
                  <span className="text-fg-muted">{t("about.noOwner")}</span>
                )}
                {page.ownerGone && page.owner && <Badge tone="warning">{t("about.ownerGone")}</Badge>}
              </dd>
              <dt className="text-fg-muted">{t("about.review")}</dt>
              <dd className="text-fg">
                {page.review.everyDays === null
                  ? t("about.noReview")
                  : t("about.reviewEvery", { period: period(page.review.everyDays, t), date: when(page.review.due!, t) })}
              </dd>
              <dt className="text-fg-muted">{t("about.readers")}</dt>
              <dd className="text-fg">{groupsText(page.space.readers, t)}</dd>
              <dt className="text-fg-muted">{t("about.editors")}</dt>
              <dd className="text-fg">{groupsText(page.space.editors, t)}</dd>
              <dt className="text-fg-muted">{t("about.linkedFrom")}</dt>
              <dd className="text-fg">
                {page.backlinks.length ? (
                  page.backlinks.map((b, i) => (
                    <span key={b.id}>
                      {i > 0 && ", "}
                      <a href={`/pages/${b.id}`}>{b.title}</a>
                    </span>
                  ))
                ) : (
                  <span className="text-fg-muted">{t("about.noLinks")}</span>
                )}
              </dd>
              <dt className="text-fg-muted">{t("about.views")}</dt>
              <dd className="text-fg">{t("about.viewsValue", { count: page.views })}</dd>
            </dl>
            <div className="mt-2.5 flex flex-wrap gap-1">
              {canEdit && (
                <Button
                  size="xs"
                  icon={<FileCheck />}
                  onClick={() =>
                    void call<Page>(`/api/v1/pages/${page.id}/review`, { method: "POST", body: "{}" }).then(
                      (p) => (update(p), say(t("page.reviewedNotice", { title: p.title }))),
                    )
                  }
                >
                  {t("page.stillRight")}
                </Button>
              )}
              <Button
                size="xs"
                onClick={() =>
                  void call<{ following: boolean }>(`/api/v1/pages/${page.id}/follow`, { method: page.following ? "DELETE" : "PUT" }).then(
                    () => reload(),
                    (err: Error) => setError(err.message),
                  )
                }
              >
                {page.following ? t("page.unfollow") : t("page.follow")}
              </Button>
              {(isAdmin || canEdit) && (
                <Button size="xs" icon={<UserRound />} onClick={() => setOwning(true)}>
                  {t("owner.change")}
                </Button>
              )}
            </div>
          </Panel>
          <Panel
            title={t("changes.title")}
            actions={
              <a href={`/pages/${page.id}/history`} className="flex items-center gap-1 text-xs">
                <History aria-hidden className="size-3.5" />
                {t("changes.all")}
              </a>
            }
          >
            <ChangeList changes={page.changes.slice(0, 5)} label={t("changes.title")} />
          </Panel>
          <Panel title={t("page.more")}>
            <div className="flex flex-wrap gap-1">
              <Button size="xs" icon={<Download />} onClick={() => window.location.assign(`/api/v1/pages/${page.id}/export?format=markdown`)}>
                {t("export.markdown")}
              </Button>
              <Button size="xs" icon={<Download />} onClick={() => window.location.assign(`/api/v1/pages/${page.id}/export?format=html`)}>
                {t("export.html")}
              </Button>
              {canEdit && (
                <>
                  <Button size="xs" icon={<FolderInput />} onClick={() => setMoving(true)}>
                    {t("move.button")}
                  </Button>
                  <Button
                    size="xs"
                    icon={<LayoutTemplate />}
                    onClick={() => patch({ template: !page.isTemplate }, page.isTemplate ? t("page.templateOff") : t("page.templateOn"))}
                  >
                    {page.isTemplate ? t("page.notTemplate") : t("page.useAsTemplate")}
                  </Button>
                </>
              )}
              {isAdmin && (
                <Button size="xs" icon={<FileCheck />} onClick={() => patch({ policy: !page.policy }, page.policy ? t("page.policyOff") : t("page.policyOn"))}>
                  {page.policy ? t("page.notPolicy") : t("page.makePolicy")}
                </Button>
              )}
              {canEdit && (
                <Button size="xs" variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)}>
                  {t("page.delete")}
                </Button>
              )}
            </div>
          </Panel>
        </div>
      </div>
      <NewPageDialog key={String(newOpen)} open={newOpen} onOpenChange={setNewOpen} parent={page} />
      <MoveDialog
        page={page}
        open={moving}
        onOpenChange={setMoving}
        onDone={(p) => (update(p), say(t("move.done", { title: p.title, space: p.space.name })))}
      />
      <OwnerDialog page={page} open={owning} onOpenChange={setOwning} onDone={(p) => (update(p), say(t("owner.done")))} />
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("delete.title", { title: page.title })}
        description={page.children.length ? t("delete.hasChildren") : t("delete.description")}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              disabled={page.children.length > 0}
              onClick={() =>
                void call(`/api/v1/pages/${page.id}`, { method: "DELETE" }).then(
                  () => {
                    setDeleting(false);
                    changed();
                    say(t("delete.done", { title: page.title }));
                    navigate(page.parent ? `/pages/${page.parent}` : `/spaces/${page.space.key}`);
                  },
                  (err: Error) => (setDeleting(false), setError(err.message)),
                )
              }
            >
              {t("page.delete")}
            </Button>
          </>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------- A space, and the start

export function SpaceView({ spaceKey }: { spaceKey: string | null }) {
  const t = useT();
  const { call, spaces } = useWiki();
  const space = spaces.find((s) => s.key === spaceKey) ?? (spaceKey ? undefined : spaces[0]);
  const [tree] = useLoad<{ pages: TreePage[] }>(call, space ? `/api/v1/spaces/${space.key}/pages` : null);
  const [found] = useLoad<{ pages: Found[] }>(call, "/api/v1/find?q=");
  const [newOpen, setNewOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  if (!spaces.length) return <EmptyState title={t("space.noneTitle")}>{t("space.noneDetail")}</EmptyState>;
  if (!space) return <EmptyState title={t("space.notFound")} />;
  const canEdit = space.role !== "viewer";
  const top = (tree?.pages ?? []).filter((p) => !p.parent);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("nav.pages"), href: "/pages" }, { label: space.name }]}
        title={space.name}
        description={space.description ?? undefined}
        meta={<Badge>{t(`role.${space.role}`)}</Badge>}
        actions={
          <>
            <Button icon={<Download />} onClick={() => window.location.assign(`/api/v1/spaces/${space.key}/export`)}>
              {t("export.space")}
            </Button>
            {canEdit && (
              <>
                <Button icon={<Upload />} onClick={() => setImporting(true)}>
                  {t("import.button")}
                </Button>
                <Button variant="primary" icon={<Plus />} onClick={() => setNewOpen(true)}>
                  {t("page.new")}
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="wiki-space-grid grid gap-2.5">
        <Tree />
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("space.pages")} flush>
            {top.length ? (
              <ul className="wiki-list wiki-rows">
                {top.map((p) => (
                  <li key={p.id}>
                    <a href={`/pages/${p.id}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <FileText aria-hidden className="size-3.5 text-fg-muted" />
                      <span className="grow truncate">{p.title}</span>
                      {p.stale && <Badge tone="warning">{t("tree.stale")}</Badge>}
                      {p.policy && <Badge tone="info">{t("tree.policy")}</Badge>}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t("space.empty")} action={canEdit && <Button onClick={() => setNewOpen(true)}>{t("page.new")}</Button>} />
            )}
          </Panel>
          <Panel title={t("space.about")}>
            <dl className="wiki-facts grid gap-x-2 gap-y-1.5 text-xs">
              <dt className="text-fg-muted">{t("about.readers")}</dt>
              <dd>{groupsText(space.readers, t)}</dd>
              <dt className="text-fg-muted">{t("about.editors")}</dt>
              <dd>{groupsText(space.editors, t)}</dd>
              <dt className="text-fg-muted">{t("space.admins")}</dt>
              <dd>{groupsText(space.admins, t)}</dd>
              <dt className="text-fg-muted">{t("about.review")}</dt>
              <dd>{space.reviewDays === null ? t("about.noReview") : period(space.reviewDays, t)}</dd>
              <dt className="text-fg-muted">{t("space.counts")}</dt>
              <dd>{t("space.countsValue", { pages: space.pages, stale: space.toReview })}</dd>
            </dl>
          </Panel>
        </div>
        <Panel title={t("space.recent")} flush className="self-start">
          <ul className="wiki-list wiki-rows">
            {(found?.pages ?? []).slice(0, 8).map((p) => (
              <li key={p.id}>
                <a href={`/pages/${p.id}`} className="flex flex-col px-3 py-1.5">
                  <span className="truncate text-sm">{p.title}</span>
                  <span className="truncate text-2xs text-fg-muted">{[p.space.name, ...p.path].join(" / ")}</span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <NewPageDialog key={String(newOpen)} open={newOpen} onOpenChange={setNewOpen} space={space.key} />
      <ImportDialog open={importing} onOpenChange={setImporting} space={space.key} />
    </>
  );
}

function ImportDialog({ open, onOpenChange, space }: { open: boolean; onOpenChange: (o: boolean) => void; space: string }) {
  const t = useT();
  const { call, changed, say } = useWiki();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("import.title")}
      description={t("import.description")}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        const md = files.filter((f) => !/\.html?$/i.test(f.name));
        const html = files.filter((f) => /\.html?$/i.test(f.name));
        const send = async (list: File[], format: string) =>
          list.length
            ? (
                await call<{ pages: unknown[] }>("/api/v1/import", {
                  method: "POST",
                  body: JSON.stringify({ space, format, files: await Promise.all(list.map(async (f) => ({ name: f.name, content: await f.text() }))) }),
                })
              ).pages.length
            : 0;
        void Promise.all([send(md, "markdown"), send(html, "html")]).then(
          ([a, b]) => {
            setBusy(false);
            onOpenChange(false);
            setFiles([]);
            changed();
            say(t("import.done", { count: a + b }));
          },
          (err: Error) => (setBusy(false), setError(err.message)),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!files.length}>
            {t("import.go", { count: files.length })}
          </Button>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5">
          {error}
        </Callout>
      )}
      <label className="flex flex-col gap-1 text-xs font-medium text-fg">
        {t("import.files")}
        <input type="file" multiple accept=".md,.markdown,.txt,.html,.htm" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </label>
    </Dialog>
  );
}

// ---------------------------------------------------------------- History

function DiffView({ changes }: { changes: DiffChange[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  // Long runs of what stayed the same fold away, with a block of each kept around a change.
  const shown = changes.map((c, i) => {
    if (c.kind !== "same" || all) return true;
    return (changes[i - 1] && changes[i - 1]!.kind !== "same") || (changes[i + 1] && changes[i + 1]!.kind !== "same");
  });
  const hidden = shown.filter((s) => !s).length;
  return (
    <div className="flex flex-col gap-1.5" aria-label={t("history.diff")}>
      {changes.every((c) => c.kind === "same") && <p className="text-sm text-fg-muted">{t("history.noChange")}</p>}
      {changes.map((c, i) =>
        !shown[i] ? null : c.kind === "changed" ? (
          <div key={i} className="wiki-diff wiki-diff-changed">
            <span className="sr-only">{t("history.changed")}</span>
            <p className="text-sm">
              {c.words!.map((w, j) =>
                w.kind === "same" ? <span key={j}>{w.text}</span> : w.kind === "added" ? <ins key={j}>{w.text}</ins> : <del key={j}>{w.text}</del>,
              )}
            </p>
          </div>
        ) : (
          <div key={i} className={`wiki-diff wiki-diff-${c.kind}`}>
            {c.kind !== "same" && <span className="sr-only">{t(`history.${c.kind}`)}</span>}
            <PageBody html={c.html} className="text-sm" />
          </div>
        ),
      )}
      {hidden > 0 && (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
            {t("history.showAll", { count: hidden })}
          </Button>
        </div>
      )}
    </div>
  );
}

export function HistoryPage({ id }: { id: string }) {
  const t = useT();
  const { call, changed, say } = useWiki();
  const [page, reloadPage] = useLoad<Page>(call, `/api/v1/pages/${id}?view=0`);
  const [list, reload] = useLoad<{ changes: Change[] }>(call, `/api/v1/pages/${id}/revisions`);
  const edits = (list?.changes ?? []).filter((c) => c.kind !== "review");
  const [n, setN] = useState<number | null>(null);
  const current = n ?? edits[0]?.n ?? null;
  const [diff] = useLoad<{ title: { before: string; after: string }; changes: DiffChange[] }>(
    call,
    current ? `/api/v1/pages/${id}/diff?from=${current - 1}&to=${current}` : null,
  );
  const [error, setError] = useState<string | null>(null);
  if (page === null) return <EmptyState title={t("page.notFound")} />;
  if (!page) return <PageHeader title={t("loading")} />;
  const chosen = edits.find((c) => c.n === current);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: page.space.name, href: `/spaces/${page.space.key}` },
          { label: page.title, href: `/pages/${page.id}` },
          { label: t("history.title") },
        ]}
        title={t("history.heading", { title: page.title })}
        description={t("history.description")}
      />
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5">
          {error}
        </Callout>
      )}
      <div className="wiki-history-grid grid gap-2.5">
        <Panel flush title={t("history.changes")} className="self-start">
          <ul className="wiki-list wiki-rows">
            {(list?.changes ?? []).map((c, i) => (
              <li key={`${c.n}-${c.kind}-${i}`}>
                <button
                  type="button"
                  disabled={c.kind === "review"}
                  aria-current={c.kind !== "review" && c.n === current ? "true" : undefined}
                  onClick={() => setN(c.n)}
                  className={`wiki-history-item flex w-full gap-2 px-3 py-2 text-left ${c.kind !== "review" && c.n === current ? "bg-accent-soft" : ""}`}
                >
                  <Avatar name={c.by.name} size="sm" className="size-5" />
                  <span className="flex min-w-0 flex-col text-xs">
                    <span className="text-fg">
                      {c.kind !== "review" && <span className="font-mono text-fg-muted">r{c.n} </span>}
                      {changeText(c, t)}
                    </span>
                    <span className="text-2xs text-fg-muted">
                      {c.by.name} · {when(c.at, t)}
                      {c.merged && ` · ${t("change.merged")}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          title={chosen ? t("history.revision", { n: chosen.n }) : t("history.diff")}
          description={chosen ? `${chosen.by.name} · ${when(chosen.at, t)}` : undefined}
          actions={
            chosen &&
            chosen.n !== page.revision &&
            page.role !== "viewer" && (
              <Button
                size="sm"
                icon={<RotateCcw />}
                onClick={() =>
                  void call<Published>(`/api/v1/pages/${id}/revisions/${chosen.n}/restore`, { method: "POST" }).then(
                    (r) => {
                      changed();
                      reload();
                      reloadPage();
                      setN(null);
                      say(r.changed ? t("history.restored", { n: chosen.n }) : t("history.sameAlready"));
                    },
                    (err: Error) => setError(err.message),
                  )
                }
              >
                {t("history.restore", { n: chosen.n })}
              </Button>
            )
          }
        >
          {diff && diff.title.before !== diff.title.after && (
            <p className="mb-2 text-sm">
              {t("history.renamed")} <del>{diff.title.before}</del> <ins>{diff.title.after}</ins>
            </p>
          )}
          {diff ? <DiffView key={current} changes={diff.changes} /> : <p className="text-sm text-fg-muted">…</p>}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Search

export function SearchPage({ query }: { query: string }) {
  const t = useT();
  const { call, spaces } = useWiki();
  const [q, setQ] = useState(query);
  // The words searched for; the address follows them, so a search can be shared.
  const [asked, setAsked] = useState(query);
  const [space, setSpace] = useState("");
  const [data] = useLoad<{ results: SearchResult[] }>(call, asked ? `/api/v1/search?q=${encodeURIComponent(asked)}${space ? `&space=${space}` : ""}` : null);
  return (
    <>
      <PageHeader title={t("search.title")} description={t("search.description")} />
      <form
        role="search"
        className="wiki-search-bar mb-2.5 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(q.trim());
          navigate(`/search?q=${encodeURIComponent(q.trim())}`, { replace: true });
        }}
      >
        <div className="grow">
          <SearchInput label={t("tree.search")} placeholder={t("tree.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <SelectField
          aria-label={t("search.space")}
          value={space}
          onChange={(e) => setSpace(e.target.value)}
          options={[{ value: "", label: t("search.allSpaces") }, ...spaces.map((s) => ({ value: s.key, label: s.name }))]}
        />
      </form>
      <Panel flush aria-label={t("search.results")}>
        {!asked ? (
          <EmptyState title={t("search.typeSomething")} />
        ) : data === undefined ? (
          <p className="px-3 py-3 text-sm text-fg-muted">…</p>
        ) : !data?.results.length ? (
          <EmptyState title={t("search.nothing", { query: asked })}>{t("search.nothingDetail")}</EmptyState>
        ) : (
          <ol className="wiki-list wiki-rows" aria-label={t("search.results")}>
            {data.results.map((r) => (
              <li key={r.id}>
                <a href={`/pages/${r.id}`} className="flex flex-col gap-0.5 px-3 py-2.5 no-underline">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    {r.title}
                    {r.policy && <Badge tone="info">{t("tree.policy")}</Badge>}
                  </span>
                  <span className="text-2xs text-fg-muted">{[r.space.name, ...r.path].join(" / ")}</span>
                  <span className="text-xs text-fg-muted">
                    {r.snippet.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}
