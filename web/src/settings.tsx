// Settings (the file, read-only) and Integrations (the API, import and export, Identity's groups).
import { Callout, PageHeader, Panel, useAgo } from "@openasy/ui";
import type { Settings } from "./api.ts";
import { Code, duration, groupsText, period } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

export function SettingsFilePage({ settings }: { settings: Settings }) {
  const t = useT();
  const ago = useAgo();
  const c = settings.config!;
  const file = settings.file;
  const name = file?.path.split("/").pop() ?? "wiki.yaml";
  return (
    <FileSettingsPage
      file={name}
      applied={file?.appliedAt ? ago(file.appliedAt) : t("settings.notYet")}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        file && (file.error || file.warnings.length > 0) ? (
          <Callout tone={file.error ? "danger" : "warning"} title={file.error ? t("settings.notApplied") : t("settings.warnings")} className="mb-2.5">
            <ul className="wiki-list flex flex-col gap-1">
              {[...(file.error ? [file.error] : []), ...file.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : undefined
      }
      groups={[
        {
          title: t("settings.wiki"),
          items: [
            { label: t("settings.name"), value: c.name, path: "wiki.name" },
            { label: t("settings.readWithin"), value: duration(c.policies.readWithinDays, t), path: "policies.read_within" },
            { label: t("settings.maxFile"), value: `${Math.round(c.attachments.maxBytes / 1024 / 1024)} MB`, path: "attachments.max_size" },
          ],
        },
        {
          title: t("settings.spaces"),
          description: t("settings.spacesDetail"),
          items: c.spaces.map((s, i) => ({
            label: s.name,
            path: `spaces[${i}]`,
            value: (
              <span className="flex flex-col gap-0.5">
                <span>{t("settings.spaceReaders", { groups: groupsText(s.readers, t) })}</span>
                <span>{t("settings.spaceEditors", { groups: groupsText(s.editors, t) })}</span>
                {s.admins.length > 0 && <span>{t("settings.spaceAdmins", { groups: groupsText(s.admins, t) })}</span>}
                <span className="text-fg-muted">
                  {t("settings.spaceReview", { period: s.reviewDays === null ? t("period.never") : period(s.reviewDays, t) })}
                </span>
              </span>
            ),
          })),
        },
        {
          title: t("settings.connections"),
          items: [
            {
              label: t("settings.mail"),
              value: c.mail ? t("settings.mailOn", { host: c.mail.host, from: c.mail.from }) : t("settings.off"),
              path: "mail",
            },
            {
              label: t("settings.directory"),
              value: settings.directory
                ? settings.directory.error
                  ? settings.directory.error
                  : settings.directory.at
                    ? t("settings.directoryOn", { url: settings.directory.url, count: settings.directory.people, when: ago(settings.directory.at) })
                    : t("settings.directoryWaiting", { url: settings.directory.url })
                : t("settings.directoryOff"),
              path: "identity",
            },
            {
              label: t("settings.fileGroups"),
              value: Object.keys(c.groups).length
                ? Object.entries(c.groups)
                    .map(([g, m]) => t("settings.groupLine", { group: g, count: m.length }))
                    .join(", ")
                : t("settings.none"),
              path: "groups",
            },
          ],
        },
      ]}
    />
  );
}

export function IntegrationsPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="wiki-split-halves grid gap-2.5">
        <Panel title={t("integrations.publish")} description={t("integrations.publishDetail")}>
          <Code label={t("integrations.publish")}>{`# A new page, from Markdown
curl -X POST ${origin}/api/v1/pages \\
  -H "authorization: Bearer $WIKI_TOKEN" -H "content-type: application/json" \\
  -d '{"space":"engineering","title":"API reference","markdown":"# ..."}'

# A new version of it: the revision it starts from, and what changed
curl -X POST ${origin}/api/v1/pages/<id>/publish \\
  -H "authorization: Bearer $WIKI_TOKEN" -H "content-type: application/json" \\
  -d '{"baseRevision":3,"markdown":"...","note":"Generated from v4.19","notify":"none"}'`}</Code>
          <p className="mt-2 text-xs">
            <a href="/api/docs/">{t("integrations.reference")}</a>
          </p>
        </Panel>
        <Panel title={t("integrations.identity")} description={t("integrations.identityDetail")}>
          <Code label={t("integrations.identity")}>{`# wiki.yaml
spaces:
  - key: engineering
    name: Engineering
    readers: [engineering]
    editors: [engineering]
    admins: [engineering-leads]
identity:
  url: https://id.example.com   # the directory, for policies
  token: WIKI_IDENTITY_TOKEN`}</Code>
        </Panel>
        <Panel title={t("integrations.import")} description={t("integrations.importDetail")}>
          <Code label={t("integrations.import")}>{`curl -X POST ${origin}/api/v1/import \\
  -H "authorization: Bearer $WIKI_TOKEN" -H "content-type: application/json" \\
  -d '{"space":"engineering","format":"markdown","files":[{"name":"deploy.md","content":"# How we deploy\\n..."}]}'`}</Code>
        </Panel>
        <Panel title={t("integrations.export")} description={t("integrations.exportDetail")}>
          <Code label={t("integrations.export")}>{`curl -OJ ${origin}/api/v1/spaces/engineering/export -H "authorization: Bearer $WIKI_TOKEN"
curl -OJ "${origin}/api/v1/pages/<id>/export?format=markdown" -H "authorization: Bearer $WIKI_TOKEN"
curl -OJ ${origin}/api/v1/policies/<id>/acknowledgements -H "authorization: Bearer $WIKI_TOKEN"`}</Code>
        </Panel>
      </div>
    </>
  );
}
