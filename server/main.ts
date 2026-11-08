import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createIdentity, IdentityError } from "./identity.ts";
import { log } from "./log.ts";
import { smtpMailer } from "./mail.ts";
import { parseProducts } from "./products.ts";
import { createWiki } from "./wiki.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.WIKI_DB ?? "/data/wiki.db";
const configPath = process.env.WIKI_CONFIG?.trim() || "/config/wiki.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.WIKI_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.WIKI_METRICS_PORT ? Number(process.env.WIKI_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open the wiki at, behind the TLS proxy (ADR 0026): cookies, passkeys, OIDC redirects and the
// links in mail use it.
const publicUrl = (process.env.WIKI_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.WIKI_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
let file: ReturnType<typeof watchConfig> | undefined;
const wiki = createWiki(db, {
  publicUrl,
  fileState: () => file?.state ?? null,
  mailerFor: (mail, password) => smtpMailer(mail, password),
  onMailError: (error, to) => log("warn", "mail not sent", { error: String(error), to }),
});
const auth = createAuth({
  db,
  product: "wiki",
  productName: "OpenAsy Wiki",
  origin: publicUrl,
  // Locally the same product is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.WIKI_PASSWORD_SIGN_IN !== "false",
  // Everyone signs in to read; what they read and write in each space follows their groups.
  users: true,
  oidc: oidcFromEnv(process.env),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Identity's groups decide who reads, edits and manages each space: they are kept at every sign-in (ADR 0033).
  onOidcSignIn: ({ userId, groups }) => {
    const u = db.prepare("SELECT email, name FROM auth_users WHERE id = ?").get(userId) as { email: string; name: string } | undefined;
    if (u) wiki.rememberPerson(userId, u.email, u.name, groups);
  },
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});

// The spaces come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config, text) => wiki.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, the wiki starts with one space everyone may read and edit, so a first look needs nothing written.
if (!wiki.config()) {
  wiki.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using the defaults until it can be read", { file: configPath });
}

/** Identity's directory, when the file names it: everyone and their groups, every 15 minutes. */
async function syncDirectory() {
  const c = wiki.config()?.identity;
  const token = wiki.identityToken();
  if (!c || !token) return;
  try {
    const people = await createIdentity({ url: c.url, token }).people();
    wiki.setDirectory(people);
  } catch (err) {
    const message = err instanceof IdentityError ? err.message : String(err);
    wiki.directoryFailed(message);
    log("warn", "Identity's directory not read", { error: message });
  }
}

const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    wiki,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(wiki, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "wiki started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "WIKI_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put it behind TLS (ADR 0026)", { url: publicUrl });
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

void syncDirectory();
wiki.purge();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => wiki.purge(), 3_600_000),
  setInterval(() => void syncDirectory(), 15 * 60_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
