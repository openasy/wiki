import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { BookOpen, Clock, FileCheck, FileText, KeyRound, LogIn, LogOut, Plug, Settings as SettingsIcon, UserRound, Users } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ProductLink, SearchResult, Settings, Space, Summary } from "./api.ts";
import { Notice, useApi } from "./common.tsx";
import { Wiki, type WikiContext } from "./context.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { HistoryPage, PageView, SearchPage, SpaceView } from "./pages.tsx";
import { PoliciesPage, ReviewPage } from "./review.tsx";
import { IntegrationsPage, SettingsFilePage } from "./settings.tsx";

// The editor (TipTap) loads when a page is first edited, so reading stays light.
const EditorPage = lazy(() => import("./editor.tsx").then((m) => ({ default: m.EditorPage })));

const PAGES = ["stale", "policies", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Route =
  | { page: "home" | (typeof PAGES)[number] }
  | { page: "space"; key: string }
  | { page: "view" | "edit" | "history"; id: string }
  | { page: "search"; q: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["pages", "spaces", "search", ...PAGES];

function parseRoute(path: string): Route {
  const [page, id, sub] = path.replace(/^\//, "").split("/");
  if (page === "pages" && id) return { page: sub === "edit" ? "edit" : sub === "history" ? "history" : "view", id: decodeURIComponent(id) };
  if (page === "spaces" && id) return { page: "space", key: decodeURIComponent(id) };
  if (page === "search") return { page: "search", q: new URLSearchParams(window.location.search).get("q") ?? "" };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "home" };
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const path = usePath();
  const route = parseRoute(path);
  const call = useApi();
  const [summary, setSummary] = useState<Summary>();
  const [spaces, setSpaces] = useState<Space[]>();
  const [settings, setSettings] = useState<Settings>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "wiki" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<{ spaces: Space[] }>("/api/v1/spaces").then(
      (r) => setSpaces(r.spaces),
      () => {},
    );
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // A notice stays for the page it was said on and the one it led to.
  useEffect(() => {
    setNotice((n) => (n && Date.now() - n.at > 1500 ? null : n));
  }, [path]);

  const ctx: WikiContext = useMemo(
    () => ({
      call,
      spaces: spaces ?? [],
      summary,
      version,
      changed: () => (setVersion((v) => v + 1), reload()),
      say: (text: string) => setNotice({ text, at: Date.now() }),
    }),
    [call, spaces, summary, version, reload],
  );

  // The search window (Cmd+K) searches every page the person can read.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ results: SearchResult[] }>(`/api/v1/search?q=${encodeURIComponent(q)}`, { signal });
      return r.results.slice(0, 10).map((p) => ({
        id: `page:${p.id}`,
        label: p.title,
        detail: [p.space.name, ...p.path].join(" / "),
        kind: t("search.page"),
        icon: FileText,
        href: `/pages/${p.id}`,
      }));
    },
    [call, t],
  );

  const nav = [
    { id: "pages", label: t("nav.pages"), icon: BookOpen },
    { id: "stale", label: t("nav.review"), icon: Clock, count: summary?.toReview || undefined },
    { id: "policies", label: t("nav.policies"), icon: FileCheck, count: summary?.policiesToRead || undefined },
  ];
  const footerNav = [
    { id: "integrations", label: t("nav.integrations"), icon: Plug },
    { id: "settings", label: t("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: t("nav.members"), icon: Users },
          { id: "signin", label: t("nav.signIn"), icon: LogIn },
          { id: "tokens", label: t("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("nav.account"), icon: UserRound },
  ];
  const active = ["home", "space", "view", "edit", "history", "search"].includes(route.page) ? "pages" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <Wiki.Provider value={ctx}>
      <AppShell
        product="wiki"
        onSearch={onSearch}
        about={colophon}
        nav={nav}
        activeNav={active}
        onNavigate={(id) => navigate(`/${id}`)}
        connectedProducts={products.map((p) => p.id)}
        onSwitchProduct={(id) => {
          const to = products.find((p) => p.id === id);
          if (to) window.location.assign(to.url);
        }}
        footerNav={account.settings(footerNav)}
        user={{ name: me.user.name, role: roleName, ...account.user }}
        theme={theme}
        onThemeChange={setTheme}
        onLanguageChange={(code) => setLocale(toLocale(code))}
      >
        {summary?.file?.error && route.page !== "settings" && (
          <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
            {summary.file.error}
          </Callout>
        )}
        {notice && <Notice>{notice.text}</Notice>}
        {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
          <AuthSettingsPage page={route.page} />
        ) : !spaces || !settings?.config ? (
          <PageHeader title={t("loading")} />
        ) : route.page === "view" ? (
          <PageView key={route.id} id={route.id} />
        ) : route.page === "edit" ? (
          <Suspense fallback={<PageHeader title={t("loading")} />}>
            <EditorPage key={route.id} id={route.id} />
          </Suspense>
        ) : route.page === "history" ? (
          <HistoryPage key={route.id} id={route.id} />
        ) : route.page === "space" ? (
          <SpaceView key={route.key} spaceKey={route.key} />
        ) : route.page === "search" ? (
          <SearchPage query={route.q} />
        ) : route.page === "stale" ? (
          <ReviewPage />
        ) : route.page === "policies" ? (
          <PoliciesPage />
        ) : route.page === "integrations" ? (
          <IntegrationsPage />
        ) : route.page === "settings" ? (
          <SettingsFilePage settings={settings} />
        ) : (
          <SpaceView spaceKey={null} />
        )}
      </AppShell>
    </Wiki.Provider>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Wiki">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
