// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  spaces: number;
  pages: number;
  policies: number;
  /** Pages past their space's review period. */
  stale: number;
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="wiki",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_wiki_spaces Spaces in the settings file.",
    "# TYPE openasy_wiki_spaces gauge",
    `openasy_wiki_spaces ${g.spaces}`,
    "# HELP openasy_wiki_pages Pages.",
    "# TYPE openasy_wiki_pages gauge",
    `openasy_wiki_pages ${g.pages}`,
    "# HELP openasy_wiki_policies Pages marked as policies.",
    "# TYPE openasy_wiki_policies gauge",
    `openasy_wiki_policies ${g.policies}`,
    "# HELP openasy_wiki_pages_to_review Pages past their space's review period.",
    "# TYPE openasy_wiki_pages_to_review gauge",
    `openasy_wiki_pages_to_review ${g.stale}`,
    "# HELP openasy_wiki_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_wiki_config_error gauge",
    `openasy_wiki_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
