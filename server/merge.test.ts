import { describe, expect, it } from "vitest";
import { diff, merge, wordDiff } from "./merge.ts";

const base = { title: "Deploy", html: "<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p>" };

describe("merge", () => {
  it("keeps changes to different blocks from both", () => {
    const m = merge(
      base,
      { title: "Deploy", html: "<p>One!</p><p>Two.</p><p>Three.</p><p>Four.</p>" },
      { title: "Deploying", html: "<p>One.</p><p>Two.</p><p>Three.</p><p>Four!</p><p>Five.</p>" },
    );
    expect(m).toMatchObject({ clean: true, title: "Deploying", html: "<p>One!</p>\n<p>Two.</p>\n<p>Three.</p>\n<p>Four!</p>\n<p>Five.</p>" });
  });

  it("takes the same change made twice once", () => {
    const same = { title: "Deploy", html: "<p>One.</p><p>2</p><p>Three.</p><p>Four.</p>" };
    expect(merge(base, same, same)).toMatchObject({ clean: true, html: "<p>One.</p>\n<p>2</p>\n<p>Three.</p>\n<p>Four.</p>" });
  });

  it("gives both versions of a block both changed, and of the title", () => {
    const m = merge(
      base,
      { title: "A", html: "<p>One.</p><p>Mine.</p><p>Three.</p><p>Four.</p>" },
      { title: "B", html: "<p>One.</p><p>Theirs.</p><p>Three.</p><p>Four.</p>" },
    );
    expect(m.clean).toBe(false);
    expect(m.titleConflict).toEqual({ mine: "A", theirs: "B" });
    expect(m.conflicts).toEqual([{ base: ["<p>Two.</p>"], mine: ["<p>Mine.</p>"], theirs: ["<p>Theirs.</p>"] }]);
    expect(m.html).toContain("Mine.");
    expect(m.theirsHtml).toContain("Theirs.");
  });
});

describe("diff", () => {
  it("names blocks changed, added and removed, with the words changed", () => {
    const d = diff(base.html, "<p>One.</p><p>Two and a half.</p><h2>New</h2><p>Four.</p>");
    expect(d.map((c) => c.kind)).toEqual(["same", "changed", "removed", "added", "same"]);
    expect(wordDiff("Use the commit", "Use the release tag")).toEqual([
      { text: "Use the ", kind: "same" },
      { text: "commit", kind: "removed" },
      { text: "release tag", kind: "added" },
    ]);
  });
});
