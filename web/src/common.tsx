// What the pages share: data loading with the session, formatting, and showing a page's HTML.
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";
import type { T } from "./i18n.ts";
import { viewerLocale } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1), setData] as const;
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="wiki-notice mb-2.5 rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
      {children}
    </div>
  );
}

/**
 * A page's body. The server sanitized it when it was written and again when it sent it (only a page's tags, http(s),
 * mailto and the wiki's own links, no script, styles or event handlers), and this page's Content-Security-Policy runs
 * no inline script either.
 */
export function PageBody({ html, className, label }: { html: string; className?: string; label?: string }) {
  return <div aria-label={label} className={`wiki-article ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="wiki-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- Formatting

export const fmt = (n: number) => n.toLocaleString(viewerLocale());
export const date = (iso: string) => new Date(iso).toLocaleDateString(viewerLocale(), { day: "numeric", month: "short", year: "numeric" });
export const dayMonth = (iso: string) => new Date(iso).toLocaleDateString(viewerLocale(), { day: "numeric", month: "short" });
export const time = (iso: string) => new Date(iso).toLocaleTimeString(viewerLocale(), { hour: "2-digit", minute: "2-digit" });

/** When something happened, as people say it: today 10:21, 28 Oct, 2 Sep 2025. */
export function when(iso: string, t: T) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t("common.todayAt", { time: time(iso) });
  return d.getFullYear() === now.getFullYear() ? dayMonth(iso) : date(iso);
}

/** A period in days as people say it: every 6 months, every year. */
export function period(days: number | null, t: T) {
  if (days === null) return t("period.never");
  if (days % 365 === 0) return t("period.years", { count: days / 365 });
  if (days % 30 === 0) return t("period.months", { count: days / 30 });
  if (days % 7 === 0) return t("period.weeks", { count: days / 7 });
  return t("period.days", { count: days });
}

/** A length of time: 14 days, 2 weeks, 6 months. */
export function duration(days: number, t: T) {
  if (days % 365 === 0) return t("duration.years", { count: days / 365 });
  if (days % 30 === 0) return t("duration.months", { count: days / 30 });
  if (days % 7 === 0) return t("duration.weeks", { count: days / 7 });
  return t("duration.days", { count: days });
}

/** Groups for a sentence: "Group engineering", "Everyone". */
export function groupsText(groups: string[], t: T) {
  if (!groups.length) return t("common.nobody");
  if (groups.includes("everyone")) return t("common.everyone");
  return t("common.groups", { count: groups.length, groups: groups.join(", ") });
}
