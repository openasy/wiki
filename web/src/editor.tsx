// Editing a page: TipTap (ProseMirror, MIT) with a toolbar and a / menu, a title, a note on what changed and whom to
// tell, the draft saved as one writes, and who else is editing. Two people may edit at once: each publishes against the
// revision they started from, and the server merges both changes or, when both changed the same part, refuses and
// sends both versions, which are shown here to choose from.
import { Badge, Button, Callout, Dialog, EmptyState, IconButton, navigate, PageHeader, Panel, SearchInput, SelectField, TextField } from "@openasy/ui";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  FileUp,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Rows3,
  Columns3,
  Table,
  TableCellsSplit,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, type Attachment, type EditConflict, type Found, type Page, type Published } from "./api.ts";
import { PageBody, time, useLoad, when } from "./common.tsx";
import { useWiki } from "./context.tsx";
import { useT, type T } from "./i18n.ts";

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

/** The heading the cursor is under, for "editing in the section ...". */
function sectionAt(editor: Editor): string | null {
  let section: string | null = null;
  const from = editor.state.selection.from;
  editor.state.doc.forEach((node, offset) => {
    if (offset < from && node.type.name === "heading") section = node.textContent;
  });
  return section;
}

interface SlashItem {
  id: string;
  label: string;
  run: (e: Editor) => void;
}

function slashItems(t: T, openLink: () => void, pickImage: () => void): SlashItem[] {
  return [
    { id: "h2", label: t("tools.heading"), run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
    { id: "h3", label: t("tools.subheading"), run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
    { id: "ul", label: t("tools.list"), run: (e) => e.chain().focus().toggleBulletList().run() },
    { id: "ol", label: t("tools.numbered"), run: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: "table", label: t("tools.table"), run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "image", label: t("tools.image"), run: () => pickImage() },
    { id: "code", label: t("tools.code"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
    { id: "quote", label: t("tools.quote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: "link", label: t("tools.pageLink"), run: () => openLink() },
    { id: "hr", label: t("tools.divider"), run: (e) => e.chain().focus().setHorizontalRule().run() },
  ];
}

function Tool({ label, icon, onClick, active, disabled }: { label: string; icon: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <IconButton
      label={label}
      size="sm"
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      className={active ? "wiki-tool-on" : undefined}
    >
      {icon}
    </IconButton>
  );
}

function Toolbar({
  editor,
  onPageLink,
  onLink,
  onImage,
  onFile,
}: {
  editor: Editor;
  onPageLink: () => void;
  onLink: () => void;
  onImage: () => void;
  onFile: () => void;
}) {
  const t = useT();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      ul: e.isActive("bulletList"),
      ol: e.isActive("orderedList"),
      code: e.isActive("codeBlock"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      table: e.isActive("table"),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label={t("tools.label")} className="wiki-toolbar flex flex-wrap gap-0.5 border-b border-line px-2 py-1.5">
      <Tool label={t("tools.heading")} icon={<Heading2 className="size-4" />} active={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()} />
      <Tool label={t("tools.subheading")} icon={<Heading3 className="size-4" />} active={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()} />
      <Tool label={t("tools.bold")} icon={<Bold className="size-4" />} active={s.bold} onClick={() => c().toggleBold().run()} />
      <Tool label={t("tools.italic")} icon={<Italic className="size-4" />} active={s.italic} onClick={() => c().toggleItalic().run()} />
      <Tool label={t("tools.list")} icon={<List className="size-4" />} active={s.ul} onClick={() => c().toggleBulletList().run()} />
      <Tool label={t("tools.numbered")} icon={<ListOrdered className="size-4" />} active={s.ol} onClick={() => c().toggleOrderedList().run()} />
      <Tool label={t("tools.quote")} icon={<Quote className="size-4" />} active={s.quote} onClick={() => c().toggleBlockquote().run()} />
      <Tool label={t("tools.table")} icon={<Table className="size-4" />} onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
      <Tool label={t("tools.image")} icon={<ImagePlus className="size-4" />} onClick={onImage} />
      <Tool label={t("tools.file")} icon={<FileUp className="size-4" />} onClick={onFile} />
      <Tool label={t("tools.code")} icon={<Code className="size-4" />} active={s.code} onClick={() => c().toggleCodeBlock().run()} />
      <Tool label={t("tools.pageLink")} icon={<Link2 className="size-4" />} onClick={onPageLink} />
      <Tool label={t("tools.link")} icon={<Link className="size-4" />} active={s.link} onClick={onLink} />
      <Tool label={t("tools.divider")} icon={<Minus className="size-4" />} onClick={() => c().setHorizontalRule().run()} />
      <span aria-hidden className="wiki-toolbar-gap" />
      <Tool label={t("tools.undo")} icon={<Undo2 className="size-4" />} disabled={!s.undo} onClick={() => c().undo().run()} />
      <Tool label={t("tools.redo")} icon={<Redo2 className="size-4" />} disabled={!s.redo} onClick={() => c().redo().run()} />
      {s.table && (
        <span role="group" aria-label={t("tools.tableGroup")} className="wiki-toolbar-table flex flex-wrap gap-0.5">
          <Tool label={t("tools.addRow")} icon={<Rows3 className="size-4" />} onClick={() => c().addRowAfter().run()} />
          <Tool label={t("tools.addColumn")} icon={<Columns3 className="size-4" />} onClick={() => c().addColumnAfter().run()} />
          <Tool label={t("tools.deleteRow")} icon={<TableCellsSplit className="size-4" />} onClick={() => c().deleteRow().run()} />
          <Tool label={t("tools.deleteColumn")} icon={<TableCellsSplit className="wiki-rotate size-4" />} onClick={() => c().deleteColumn().run()} />
          <Tool label={t("tools.deleteTable")} icon={<Trash2 className="size-4" />} onClick={() => c().deleteTable().run()} />
        </span>
      )}
    </div>
  );
}

function PageLinkDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (p: Found) => void }) {
  const t = useT();
  const { call } = useWiki();
  const [q, setQ] = useState("");
  const [data] = useLoad<{ pages: Found[] }>(call, open ? `/api/v1/find?q=${encodeURIComponent(q)}` : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("linkPage.title")} description={t("linkPage.description")}>
      <SearchInput label={t("linkPage.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="wiki-list wiki-rows wiki-pick mt-2" aria-label={t("linkPage.results")}>
        {(data?.pages ?? []).slice(0, 12).map((p) => (
          <li key={p.id}>
            <button type="button" className="flex w-full flex-col px-2 py-1.5 text-left" onClick={() => onPick(p)}>
              <span className="text-sm text-fg">{p.title}</span>
              <span className="text-2xs text-fg-muted">{[p.space.name, ...p.path].join(" / ")}</span>
            </button>
          </li>
        ))}
        {data && !data.pages.length && <li className="px-2 py-1.5 text-sm text-fg-muted">{t("linkPage.none")}</li>}
      </ul>
    </Dialog>
  );
}

function LinkDialog({
  open,
  onOpenChange,
  initial,
  onSet,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: string;
  onSet: (href: string | null) => void;
}) {
  const t = useT();
  const [href, setHref] = useState(initial);
  useEffect(() => setHref(initial), [initial, open]);
  const valid = /^(https?:\/\/|mailto:|\/)/i.test(href.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("link.title")}
      onSubmit={(e) => {
        e.preventDefault();
        onSet(href.trim() || null);
      }}
      footer={
        <>
          {initial && (
            <Button type="button" onClick={() => onSet(null)}>
              {t("link.remove")}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!valid}>
            {t("link.set")}
          </Button>
        </>
      }
    >
      <TextField label={t("link.address")} value={href} placeholder="https://" onChange={(e) => setHref(e.target.value)} hint={t("link.hint")} />
    </Dialog>
  );
}

/** Both versions of the parts two people changed, to choose one. */
function ConflictPanel({ conflict, onChoose }: { conflict: EditConflict; onChoose: (which: "mine" | "theirs") => void }) {
  const t = useT();
  return (
    <Panel
      title={t("conflict.title")}
      description={t("conflict.description", { name: conflict.by.name, when: when(conflict.at, t) })}
      aria-label={t("conflict.title")}
    >
      <div className="flex flex-col gap-3">
        {conflict.titleConflict && (
          <div className="wiki-conflict grid gap-2">
            <div>
              <h3 className="mb-1 text-xs font-semibold text-fg-muted">{t("conflict.theirs", { name: conflict.by.name })}</h3>
              <p className="text-sm font-semibold">{conflict.titleConflict.theirs}</p>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold text-fg-muted">{t("conflict.mine")}</h3>
              <p className="text-sm font-semibold">{conflict.titleConflict.mine}</p>
            </div>
          </div>
        )}
        {conflict.conflicts.map((c, i) => (
          <div key={i} className="wiki-conflict grid gap-2">
            <div className="wiki-diff wiki-diff-removed">
              <h3 className="mb-1 text-xs font-semibold text-fg-muted">{t("conflict.theirs", { name: conflict.by.name })}</h3>
              <PageBody html={c.theirs.join("") || `<p>${t("conflict.removed")}</p>`} className="text-sm" />
            </div>
            <div className="wiki-diff wiki-diff-added">
              <h3 className="mb-1 text-xs font-semibold text-fg-muted">{t("conflict.mine")}</h3>
              <PageBody html={c.mine.join("") || `<p>${t("conflict.removed")}</p>`} className="text-sm" />
            </div>
          </div>
        ))}
        <p className="text-xs text-fg-muted">{t("conflict.rest")}</p>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="primary" onClick={() => onChoose("mine")}>
            {t("conflict.keepMine")}
          </Button>
          <Button onClick={() => onChoose("theirs")}>{t("conflict.keepTheirs", { name: conflict.by.name })}</Button>
        </div>
      </div>
    </Panel>
  );
}

export function EditorPage({ id }: { id: string }) {
  const t = useT();
  const { call, changed, say } = useWiki();
  const [page] = useLoad<Page>(call, `/api/v1/pages/${id}?view=0`);
  const [title, setTitle] = useState("");
  const [base, setBase] = useState(0);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState("followers");
  const [saved, setSaved] = useState<string | null>(null);
  const [resumed, setResumed] = useState<string | null>(null);
  const [others, setOthers] = useState<Page["presence"]>([]);
  const [moved, setMoved] = useState<{ revision: number; by: string; at: string } | null>(null);
  const [conflict, setConflict] = useState<EditConflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [pageLink, setPageLink] = useState(false);
  const [link, setLink] = useState(false);
  const [slash, setSlash] = useState<{ from: number; to: number; query: string; x: number; y: number; index: number } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  const baseRef = useRef(base);
  baseRef.current = base;
  const titleRef = useRef(title);
  titleRef.current = title;
  const dirty = useRef(false);

  const upload = useCallback(
    async (file: File) => {
      setUploading((n) => n + 1);
      try {
        return await call<Attachment>(`/api/v1/pages/${id}/attachments?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
      } finally {
        setUploading((n) => n - 1);
      }
    },
    [call, id],
  );

  const editorRef = useRef<Editor | null>(null);
  const insertFiles = useCallback(
    (files: File[]) => {
      for (const f of files)
        void upload(f).then(
          (a) => {
            const e = editorRef.current;
            if (!e) return;
            if (IMAGE.test(a.type)) e.chain().focus().setImage({ src: a.url, alt: a.name }).run();
            else
              e.chain()
                .focus()
                .insertContent([
                  { type: "text", text: a.name, marks: [{ type: "link", attrs: { href: a.url } }] },
                  { type: "text", text: " " },
                ])
                .run();
          },
          (err: Error) => setError(err.message),
        );
    },
    [upload],
  );

  const items = slashItems(
    t,
    () => setPageLink(true),
    () => imageInput.current?.click(),
  );
  const shownItems = slash ? items.filter((i) => i.label.toLocaleLowerCase().includes(slash.query.toLocaleLowerCase())) : [];
  const shownRef = useRef(shownItems);
  shownRef.current = shownItems;

  const runSlash = (item: SlashItem) => {
    const e = editorRef.current;
    const s = slashRef.current;
    if (!e || !s) return;
    e.chain().focus().deleteRange({ from: s.from, to: s.to }).run();
    setSlash(null);
    item.run(e);
  };
  const runSlashRef = useRef(runSlash);
  runSlashRef.current = runSlash;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true, protocols: ["mailto"] } }),
      TableKit.configure({ table: { resizable: false } }),
      Image,
      Placeholder.configure({ placeholder: t("editor.placeholder") }),
    ],
    editorProps: {
      attributes: { class: "wiki-article wiki-editor-body", "aria-label": t("editor.region"), role: "textbox", "aria-multiline": "true" },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length) return false;
        insertFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length) return false;
        insertFiles(files);
        return true;
      },
      handleKeyDown: (_view, event) => {
        const s = slashRef.current;
        if (!s) return false;
        const list = shownRef.current;
        if (event.key === "Escape") return (setSlash(null), true);
        if (!list.length) return false;
        if (event.key === "ArrowDown") return (setSlash({ ...s, index: (s.index + 1) % list.length }), true);
        if (event.key === "ArrowUp") return (setSlash({ ...s, index: (s.index - 1 + list.length) % list.length }), true);
        if (event.key === "Enter") return (runSlashRef.current(list[Math.min(s.index, list.length - 1)]!), true);
        return false;
      },
    },
    onUpdate: () => {
      if (loaded.current) dirty.current = true;
    },
    onTransaction: ({ editor: e }) => {
      // The / menu: a slash at the start of a word in a paragraph, and what follows it.
      const { $from, empty } = e.state.selection;
      if (!empty || $from.parent.type.name !== "paragraph") return setSlash(null);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
      const m = /(?:^|\s)\/([\p{L}\d ]{0,20})$/u.exec(before);
      if (!m || m[1]!.endsWith(" ")) return setSlash(null);
      const at = e.view.coordsAtPos($from.pos);
      setSlash((s) => ({
        from: $from.pos - m[1]!.length - 1,
        to: $from.pos,
        query: m[1]!,
        x: at.left,
        y: at.bottom + 4,
        index: s && s.query === m[1] ? s.index : 0,
      }));
    },
  });
  editorRef.current = editor;

  // The page, or the draft left last time, into the editor once.
  useEffect(() => {
    if (!page || !editor || loaded.current) return;
    void call<{ base: number; title: string; html: string; savedAt: string }>(`/api/v1/pages/${id}/draft`).then(
      (d) => {
        editor.commands.setContent(d.html, { emitUpdate: false });
        setTitle(d.title);
        setBase(d.base);
        setResumed(d.savedAt);
        setSaved(d.savedAt);
        loaded.current = true;
      },
      () => {
        editor.commands.setContent(page.html, { emitUpdate: false });
        setTitle(page.title);
        setBase(page.revision);
        loaded.current = true;
      },
    );
  }, [page, editor, call, id]);

  // The draft is kept on the server as one writes, every few seconds.
  useEffect(() => {
    const timer = setInterval(() => {
      const e = editorRef.current;
      if (!e || !loaded.current || !dirty.current) return;
      dirty.current = false;
      void call<{ savedAt: string }>(`/api/v1/pages/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ base: baseRef.current, title: titleRef.current || page?.title || "Untitled", html: e.getHTML() }),
      }).then(
        (r) => setSaved(r.savedAt),
        () => (dirty.current = true),
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [call, id, page?.title]);

  // Who else is here, and whether the page was published since this edit started.
  useEffect(() => {
    let live = true;
    const ping = () => {
      const e = editorRef.current;
      void call<{ revision: number; lastChange: { by: { name: string }; at: string } | null; people: Page["presence"] }>(`/api/v1/pages/${id}/presence`, {
        method: "POST",
        body: JSON.stringify({ editing: true, section: e ? sectionAt(e) : null }),
      }).then(
        (r) => {
          if (!live) return;
          setOthers(r.people);
          setMoved(
            baseRef.current && r.revision > baseRef.current && r.lastChange ? { revision: r.revision, by: r.lastChange.by.name, at: r.lastChange.at } : null,
          );
        },
        () => {},
      );
    };
    ping();
    const timer = setInterval(ping, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
      void call(`/api/v1/pages/${id}/presence`, { method: "POST", body: JSON.stringify({ leave: true }) }).catch(() => {});
    };
  }, [call, id]);

  if (page === null) return <EmptyState title={t("page.notFound")} />;
  if (!page || !editor) return <PageHeader title={t("loading")} />;
  if (page.role === "viewer") return <EmptyState title={t("editor.readOnly")}>{t("editor.readOnlyDetail")}</EmptyState>;

  const publish = () => {
    setBusy(true);
    setError(null);
    void call<Published>(`/api/v1/pages/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ baseRevision: base, title: title.trim() || page.title, html: editor.getHTML(), note: note.trim() || null, notify }),
    }).then(
      (r) => {
        setBusy(false);
        changed();
        const parts = [
          !r.changed ? t("editor.noChange") : note.trim() ? t("editor.published", { note: note.trim() }) : t("editor.publishedPlain"),
          r.merged ? t("editor.mergedNotice") : "",
          r.told ? t("editor.told", { count: r.told }) : "",
        ];
        say(parts.filter(Boolean).join(" "));
        navigate(`/pages/${id}`);
      },
      (err: Error) => {
        setBusy(false);
        if (err instanceof ApiError && err.code === "edit-conflict") setConflict(err.problem as unknown as EditConflict);
        else setError(err.message);
      },
    );
  };

  const choose = (which: "mine" | "theirs") => {
    if (!conflict) return;
    const v = conflict[which];
    editor.commands.setContent(v.html, { emitUpdate: true });
    setTitle(v.title);
    setBase(conflict.revision);
    setConflict(null);
    setMoved(null);
    say(t("conflict.chosen"));
  };

  const editingToo = others.filter((o) => o.editing);
  const viewing = others.filter((o) => !o.editing);
  const isPolicy = !!page.policy;
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: page.space.name, href: `/spaces/${page.space.key}` },
          ...page.ancestors.map((a) => ({ label: a.title, href: `/pages/${a.id}` })),
          { label: page.title, href: `/pages/${page.id}` },
          { label: t("editor.crumb") },
        ]}
        title={t("editor.title", { title: page.title })}
        meta={
          <>
            {saved ? <Badge>{t("editor.saved", { time: time(saved) })}</Badge> : <Badge>{t("editor.notSaved")}</Badge>}
            {uploading > 0 && <Badge tone="info">{t("editor.uploading", { count: uploading })}</Badge>}
          </>
        }
        actions={
          <>
            <Button onClick={() => navigate(`/pages/${id}`)}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={busy} disabled={!!conflict} onClick={publish}>
              {t("editor.publish")}
            </Button>
          </>
        }
      />
      {resumed && (
        <Callout
          tone="info"
          title={t("editor.resumed", { when: when(resumed, t) })}
          className="mb-2.5"
          action={
            <Button
              size="sm"
              onClick={() =>
                void call(`/api/v1/pages/${id}/draft`, { method: "DELETE" }).then(() => {
                  editor.commands.setContent(page.html, { emitUpdate: false });
                  setTitle(page.title);
                  setBase(page.revision);
                  setResumed(null);
                  setSaved(null);
                  dirty.current = false;
                })
              }
            >
              {t("editor.discard")}
            </Button>
          }
        >
          {t("editor.resumedDetail")}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}
      <div className="wiki-editor-grid grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          {conflict && <ConflictPanel conflict={conflict} onChoose={choose} />}
          <Panel flush aria-label={t("editor.panel")}>
            <Toolbar
              editor={editor}
              onPageLink={() => setPageLink(true)}
              onLink={() => setLink(true)}
              onImage={() => imageInput.current?.click()}
              onFile={() => fileInput.current?.click()}
            />
            <div className="wiki-editor-wrap">
              <input
                aria-label={t("editor.pageTitle")}
                className="wiki-title-input"
                value={title}
                maxLength={200}
                onChange={(e) => ((dirty.current = true), setTitle(e.target.value))}
              />
              <EditorContent editor={editor} />
              <p className="wiki-hint text-xs text-fg-subtle">{t("editor.hint")}</p>
            </div>
          </Panel>
          {slash && shownItems.length > 0 && (
            <div role="listbox" aria-label={t("tools.slash")} className="wiki-slash" style={{ left: slash.x, top: slash.y }}>
              {shownItems.map((item, i) => (
                <div
                  key={item.id}
                  tabIndex={-1}
                  role="option"
                  aria-selected={i === slash.index}
                  className={i === slash.index ? "wiki-slash-on" : undefined}
                  onMouseDown={(e) => (e.preventDefault(), runSlash(item))}
                >
                  {item.label}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("editor.publishPanel")}>
            <div className="flex flex-col gap-2">
              <TextField
                label={t("editor.whatChanged")}
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("editor.whatChangedPlaceholder")}
              />
              <SelectField
                label={t("editor.tell")}
                value={notify}
                onChange={(e) => setNotify(e.target.value)}
                options={[
                  { value: "none", label: t("editor.tellNone") },
                  { value: "followers", label: t("editor.tellFollowers") },
                  { value: "everyone", label: t("editor.tellEveryone") },
                ]}
              />
              {isPolicy && (
                <p className="text-xs text-fg-muted">
                  {notify === "none" ? t("editor.policySmallFix") : t("editor.policyNewVersion", { version: page.policy!.version + 1 })}
                </p>
              )}
            </div>
          </Panel>
          {moved && !conflict && (
            <Callout tone="warning" title={t("editor.movedTitle", { name: moved.by })}>
              {t("editor.movedDetail", { when: when(moved.at, t) })}
            </Callout>
          )}
          {editingToo.map((o) => (
            <Callout key={o.name} tone="info" title={t("editor.alsoEditing", { name: o.name })}>
              {o.section ? t("editor.alsoIn", { name: o.name, section: o.section }) : t("editor.alsoDetail")}
            </Callout>
          ))}
          {viewing.length > 0 && (
            <p className="text-xs text-fg-muted">{t("editor.reading", { names: viewing.map((v) => v.name).join(", "), count: viewing.length })}</p>
          )}
        </div>
      </div>
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        hidden
        onChange={(e) => (insertFiles([...(e.target.files ?? [])]), (e.target.value = ""))}
      />
      <input ref={fileInput} type="file" hidden onChange={(e) => (insertFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
      <PageLinkDialog
        open={pageLink}
        onOpenChange={setPageLink}
        onPick={(p) => {
          setPageLink(false);
          const { empty, from } = editor.state.selection;
          // A space before the link when the cursor is right after a word.
          const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, undefined, " ") : " ";
          if (empty)
            editor
              .chain()
              .focus()
              .insertContent([
                ...(before.trim() ? [{ type: "text", text: " " }] : []),
                { type: "text", text: p.title, marks: [{ type: "link", attrs: { href: `/pages/${p.id}` } }] },
                { type: "text", text: " " },
              ])
              .run();
          else
            editor
              .chain()
              .focus()
              .setLink({ href: `/pages/${p.id}` })
              .run();
        }}
      />
      <LinkDialog
        open={link}
        onOpenChange={setLink}
        initial={(editor.getAttributes("link").href as string | undefined) ?? ""}
        onSet={(href) => {
          setLink(false);
          if (!href) editor.chain().focus().extendMarkRange("link").unsetLink().run();
          else if (editor.state.selection.empty && !editor.isActive("link"))
            editor
              .chain()
              .focus()
              .insertContent([{ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }])
              .run();
          else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
        }}
      />
    </>
  );
}
