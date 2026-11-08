import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, periodDays, watchConfig } from "./config.ts";
import { SETTINGS } from "./test-app.ts";

describe("the settings file", () => {
  it("reads the spaces, their groups and periods", () => {
    const c = parseConfig(SETTINGS);
    expect(c.name).toBe("Acme handbook");
    expect(c.spaces.map((s) => [s.key, s.reviewDays, s.readers, s.editors, s.admins])).toEqual([
      ["engineering", 180, ["engineering"], ["engineering"], ["engineering-leads"]],
      ["people", 360, ["everyone"], ["people-team"], []],
      ["sales", 365, ["sales"], ["sales"], []],
    ]);
    expect(c.policies.readWithinDays).toBe(14);
    expect(c.groups.engineering).toEqual(["emre@example.com", "dana@example.com"]);
    expect(c.mail).toMatchObject({ host: "mail.example.com", port: 587, security: "starttls", password: "WIKI_SMTP_PASSWORD" });
    expect(c.attachments.maxBytes).toBe(20 * 1024 * 1024);
  });

  it("reads the example in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/wiki.yaml", import.meta.url), "utf8"));
    expect(c.spaces.map((s) => s.key)).toEqual(["engineering", "people", "sales"]);
  });

  it("starts with one space for everyone when there is no file", () => {
    expect(parseConfig("").spaces).toEqual([
      { key: "general", name: "General", description: null, reviewDays: 365, readers: ["everyone"], editors: ["everyone"], admins: [] },
    ]);
  });

  it("names the field to fix", () => {
    const bad: Array<[string, string]> = [
      ["nope: 1", "The file: unknown nope"],
      ["spaces: [{ key: Eng, name: E, readers: [a] }]", "spaces[0].key"],
      ["spaces: [{ key: e, name: E }]", "spaces[0]: name at least one group"],
      ["spaces: [{ key: e, name: E, readers: [a] }, { key: e, name: F, readers: [a] }]", "in the file twice"],
      ["spaces: [{ key: e, name: E, readers: [a], review: soon }]", "spaces[0].review is a period"],
      ["groups: { everyone: [a@example.com] }", "groups.everyone"],
      ["groups: { eng: [not-an-email] }", "groups.eng is a list of email"],
      ["mail: { host: m, from: f, password: secret123 }", "mail.password is the name of an environment variable"],
      ["attachments: { max_size: 2 GB }", "attachments.max_size"],
      ["identity: { url: http://id.example.com }", "identity.url"],
      ["{", "Not valid YAML"],
    ];
    for (const [raw, msg] of bad) expect(() => parseConfig(raw), raw).toThrow(msg);
    expect(parseConfig("identity: { url: http://identity:8080 }").identity).toEqual({ url: "http://identity:8080", token: "WIKI_IDENTITY_TOKEN" });
  });

  it("reads periods", () => {
    expect([periodDays("90 days", "x"), periodDays("2 weeks", "x"), periodDays("6 months", "x"), periodDays("1 year", "x"), periodDays("never", "x")]).toEqual([
      90,
      14,
      180,
      365,
      null,
    ]);
  });

  it("keeps the last good file when a new one has a mistake", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wiki-")), "wiki.yaml");
    writeFileSync(path, "wiki: { name: First }");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.name), []), { everyMs: 60_000 });
    writeFileSync(path, "wiki: { name: [broken] }");
    w.read();
    expect(applied).toEqual(["First"]);
    expect(w.state.error).toContain("wiki.name");
    w.stop();
  });
});
