// Upkeep: pages past their review period for their owners, and policies with who has not read their current version.
import { Avatar, Badge, Button, Callout, DataTable, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, StatusBadge, Tabs, type Column } from "@openasy/ui";
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import type { Page, PolicyDetail, PolicyRow, Review, ReviewItem } from "./api.ts";
import { dayMonth, duration, fmt, period, useLoad, when } from "./common.tsx";
import { useWiki } from "./context.tsx";
import { useT } from "./i18n.ts";

export function ReviewPage() {
  const t = useT();
  const { call, spaces, changed, say } = useWiki();
  const [data, reload] = useLoad<Review>(call, "/api/v1/review");
  const [space, setSpace] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const rows = (data?.pages ?? []).filter((p) => space === "all" || p.space.key === space);
  const canReview = (p: ReviewItem) => spaces.find((s) => s.key === p.space.key)?.role !== "viewer";
  const cols: Column<ReviewItem>[] = [
    {
      id: "title",
      header: t("review.page"),
      width: "28%",
      sortValue: (p) => p.title,
      cell: (p) => (
        <a href={`/pages/${p.id}`} className="flex min-w-0 items-center gap-2 no-underline">
          <FileText aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-fg">{p.title}</span>
            <span className="text-2xs text-fg-muted">{p.space.name}</span>
          </span>
        </a>
      ),
    },
    {
      id: "owner",
      header: t("about.owner"),
      sortValue: (p) => p.owner?.name ?? "",
      cell: (p) => (
        <span className="flex items-center gap-1.5">
          {p.owner ? (
            <>
              <Avatar name={p.owner.name} size="sm" className="size-5" />
              <span className="truncate text-xs">{p.owner.name}</span>
            </>
          ) : (
            <span className="text-xs text-fg-muted">{t("about.noOwner")}</span>
          )}
          {p.ownerGone && p.owner && <Badge tone="warning">{t("about.ownerGone")}</Badge>}
        </span>
      ),
    },
    {
      id: "reviewed",
      header: t("review.lastReview"),
      sortValue: (p) => p.reviewedAt,
      cell: (p) => <span className="text-xs whitespace-nowrap">{when(p.reviewedAt, t)}</span>,
    },
    {
      id: "overdue",
      header: t("review.overdue"),
      sortValue: (p) => p.overdueDays,
      cell: (p) => (
        <StatusBadge tone={p.overdueDays > 60 ? "danger" : p.overdueDays > 0 ? "warning" : "neutral"}>
          {p.overdueDays ? t("review.days", { count: p.overdueDays }) : t("review.dueToday")}
        </StatusBadge>
      ),
    },
    { id: "views", header: t("review.views"), align: "right", mono: true, sortValue: (p) => p.views, cell: (p) => fmt(p.views) },
    {
      id: "act",
      header: <span className="sr-only">{t("review.markReviewed")}</span>,
      align: "right",
      cell: (p) =>
        canReview(p) && (
          <Button
            size="xs"
            onClick={() =>
              void call<Page>(`/api/v1/pages/${p.id}/review`, { method: "POST", body: "{}" }).then(
                () => (reload(), changed(), say(t("page.reviewedNotice", { title: p.title }))),
                (err: Error) => setError(err.message),
              )
            }
          >
            {t("page.stillRight")}
          </Button>
        ),
    },
  ];
  const periods = (data?.spaces ?? [])
    .filter((s) => s.reviewDays !== null)
    .slice(0, 3)
    .map((s) => t("review.spacePeriod", { space: s.name, period: period(s.reviewDays, t) }))
    .join(", ");
  const delta = data ? data.totals.reviewedThisMonth - data.totals.reviewedLastMonth : 0;
  return (
    <>
      <PageHeader title={t("review.title")} description={t("review.description", { periods: periods || t("review.noPeriods") })} />
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}
      {data && (
        <KpiGrid minWidth={170} className="mb-2.5">
          <KpiCard label={t("review.pages")} value={fmt(data.totals.pages)} unit={t("review.inSpaces", { count: data.totals.spaces })} />
          <KpiCard
            label={t("review.toReview")}
            value={fmt(data.totals.toReview)}
            delta={{ label: t("review.over60", { count: data.totals.overdue60 }), intent: data.totals.overdue60 ? "bad" : "neutral" }}
          />
          <KpiCard label={t("review.ownerGone")} value={fmt(data.totals.ownerGone)} delta={{ label: t("review.needsOwner"), intent: "neutral" }} />
          <KpiCard
            label={t("review.thisMonth")}
            value={fmt(data.totals.reviewedThisMonth)}
            delta={{
              label: t("review.vsLast", { change: (delta > 0 ? "+" : "") + delta }),
              direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
              intent: delta >= 0 ? "good" : "bad",
            }}
          />
        </KpiGrid>
      )}
      <Panel flush>
        <div className="px-3 pt-2">
          <Tabs
            label={t("review.space")}
            value={space}
            onChange={setSpace}
            items={[
              { value: "all", label: t("review.allSpaces"), count: data?.pages.length ?? 0 },
              ...(data?.spaces ?? []).map((s) => ({ value: s.key, label: s.name, count: data!.pages.filter((p) => p.space.key === s.key).length })),
            ]}
            className="border-b-0"
          />
        </div>
        <div className="border-t border-line">
          <DataTable
            label={t("review.table")}
            columns={cols}
            rows={rows}
            getRowId={(p) => p.id}
            defaultSort={{ id: "views", direction: "desc" }}
            minWidth={820}
            loading={data === undefined}
            empty={<EmptyState title={t("review.nothing")}>{t("review.nothingDetail")}</EmptyState>}
          />
        </div>
      </Panel>
    </>
  );
}

function PolicyPanel({ id }: { id: string }) {
  const t = useT();
  const { call } = useWiki();
  const [p, reload] = useLoad<PolicyDetail>(call, `/api/v1/policies/${id}`);
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!p) return <Panel aria-label={t("policies.notReadRegion")} className="self-start" />;
  const missing = p.readers - p.read;
  return (
    <Panel
      aria-label={t("policies.notReadRegion")}
      title={missing ? t("policies.notRead", { count: missing, version: p.version }) : t("policies.allRead", { version: p.version })}
      description={p.title}
      className="self-start"
      actions={
        p.canRemind &&
        missing > 0 && (
          <Button
            size="sm"
            disabled={sent !== null}
            onClick={() =>
              void call<{ sent: number; failed: number }>(`/api/v1/policies/${id}/remind`, { method: "POST" }).then(
                (r) => (setSent(r.sent), r.failed && setError(t("policies.notSent", { count: r.failed })), reload()),
                (err: Error) => setError(err.message),
              )
            }
          >
            {t("policies.remind")}
          </Button>
        )
      }
    >
      {error && (
        <Callout tone="warning" title={t("policies.remindFailed")} className="mb-2">
          {error}
        </Callout>
      )}
      {!p.canRemind ? (
        <p className="text-sm text-fg-muted">{p.readByMe ? t("policies.youRead") : t("policies.youHaveNot")}</p>
      ) : missing === 0 ? (
        <p className="text-sm text-fg-muted">{t("policies.everyone")}</p>
      ) : (
        <ul aria-label={t("policies.notReadList")} className="wiki-list flex flex-col gap-1.5">
          {p.notRead.map((r) => (
            <li key={r.email} className="flex items-center gap-2 text-sm">
              <Avatar name={r.name} size="sm" className="size-5" />
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-fg">{r.name}</span>
                <span className="truncate text-2xs text-fg-muted">
                  {r.groups.length ? r.groups.join(", ") : r.email}
                  {!r.signedIn && ` · ${t("policies.neverSignedIn")}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {sent !== null && sent > 0 && (
        <p role="status" className="mt-2 text-xs text-success">
          {t("policies.sent", { count: sent })}
        </p>
      )}
      {p.reminders.length > 0 && sent === null && (
        <p className="mt-2 text-2xs text-fg-muted">{t("policies.lastReminder", { when: when(p.reminders[0]!.at, t), count: p.reminders[0]!.sent })}</p>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1">
        <a href={`/pages/${p.id}`} className="text-xs">
          {t("policies.open")}
        </a>
        {p.canRemind && (
          <a href={`/api/v1/policies/${p.id}/acknowledgements`} className="ml-auto flex items-center gap-1 text-xs" download>
            <Download aria-hidden className="size-3.5" />
            {t("policies.csv")}
          </a>
        )}
      </div>
    </Panel>
  );
}

export function PoliciesPage() {
  const t = useT();
  const { call } = useWiki();
  const [data] = useLoad<{ readWithinDays: number; mail: boolean; policies: PolicyRow[] }>(call, "/api/v1/policies");
  const [active, setActive] = useState<string | null>(null);
  const rows = data?.policies ?? [];
  const current = active ?? rows.find((p) => !p.done)?.id ?? rows[0]?.id;
  const cols: Column<PolicyRow>[] = [
    {
      id: "title",
      header: t("policies.policy"),
      width: "34%",
      sortValue: (p) => p.title,
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{p.title}</span>
          <span className="text-2xs text-fg-muted">
            {t("policies.versionLine", { version: p.version, space: p.space.name, date: p.changedAt ? dayMonth(p.changedAt) : "" })}
          </span>
        </span>
      ),
    },
    {
      id: "read",
      header: t("policies.readCurrent"),
      width: "34%",
      sortValue: (p) => (p.readers ? p.read / p.readers : 1),
      cell: (p) => (
        <span className="flex items-center gap-2">
          <span aria-hidden className="wiki-bar">
            <span className={p.done ? "wiki-bar-done" : "wiki-bar-fill"} style={{ width: `${p.readers ? (p.read / p.readers) * 100 : 100}%` }} />
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums">{t("policies.readOf", { read: p.read, readers: p.readers })}</span>
        </span>
      ),
    },
    {
      id: "due",
      header: t("policies.by"),
      sortValue: (p) => p.due ?? "",
      cell: (p) => (
        <StatusBadge tone={p.done ? "success" : p.overdue ? "danger" : "neutral"}>
          {p.done ? t("policies.done") : p.overdue ? t("policies.overdue") : p.due ? dayMonth(p.due) : "–"}
        </StatusBadge>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("policies.title")} description={t("policies.description", { period: duration(data?.readWithinDays ?? 14, t) })} />
      {data && !data.mail && (
        <Callout tone="info" title={t("policies.noMail")} className="mb-2.5">
          {t("policies.noMailDetail")}
        </Callout>
      )}
      <div className="wiki-split-side grid gap-2.5">
        <Panel flush title={t("policies.title")}>
          <DataTable
            label={t("policies.title")}
            columns={cols}
            rows={rows}
            getRowId={(p) => p.id}
            onRowClick={(p) => setActive(p.id)}
            activeRowId={current}
            minWidth={600}
            loading={data === undefined}
            empty={<EmptyState title={t("policies.none")}>{t("policies.noneDetail")}</EmptyState>}
          />
        </Panel>
        {current && <PolicyPanel key={current} id={current} />}
      </div>
    </>
  );
}
