import { describe, expect, it } from "vitest";
import { blocks, fold, headings, importFile, pageLinks, plainText, sanitize, snippet, terms, toHtml, toMarkdown } from "./content.ts";

describe("sanitize", () => {
  it("keeps a page's tags and drops everything that could run", () => {
    const dirty = [
      `<h1>Title</h1><p style="color:red" onclick="x()">Hi <a href="javascript:alert(1)">x</a> <a href="https://e.com" target="_top">e</a></p>`,
      `<script>alert(1)</script><style>p{}</style><iframe src="https://e.com"></iframe><form><input></form><svg><script>1</script></svg>`,
      `<img src="x" onerror="alert(1)"><img src="data:image/png;base64,AAAA"><img src="/api/v1/attachments/abcdefgh12/a.png" alt="a">`,
      `<table><colgroup><col style="min-width:25px"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>c</p></td><td colspan="2">d</td></tr></tbody></table>`,
      `<pre><code class="language-ts evil">x</code></pre><a href="//evil.example">p</a><a href="/pages/abcdefgh">in</a>`,
    ].join("");
    expect(sanitize(dirty)).toBe(
      [
        `<h2>Title</h2><p>Hi <a>x</a> <a href="https://e.com" rel="noopener noreferrer nofollow" target="_blank">e</a></p>`,
        `<img src="/api/v1/attachments/abcdefgh12/a.png" alt="a" />`,
        `<table><tbody><tr><td><p>c</p></td><td colspan="2">d</td></tr></tbody></table>`,
        `<pre><code class="language-ts">x</code></pre><a>p</a><a href="/pages/abcdefgh">in</a>`,
      ].join(""),
    );
  });
});

describe("words", () => {
  it("folds Turkish and accents alike", () => {
    expect(fold("İSTANBUL Işık şirket ÇAĞRI Ünlü café")).toBe("istanbul isik sirket cagri unlu cafe");
    expect(terms("Şifre, sıfırlama!")).toEqual(["sifre", "sifirlama"]);
  });

  it("marks the search's words in a snippet of the original text", () => {
    const text = `${"lorem ".repeat(30)}Şifrenizi İstanbul ofisinde sıfırlayın.`;
    const s = snippet(text, ["sifre", "istanbul"]);
    expect(s.filter((x) => x.hit).map((x) => x.text)).toEqual(["Şifrenizi", "İstanbul"]);
    expect(s[0]!.text.startsWith("…")).toBe(true);
  });

  it("reads plain text, headings, links and blocks", () => {
    const html = `<p>A&amp;B</p><h2>Rolling <em>back</em></h2><ul><li>x</li></ul><a href="/pages/abcdefgh#top">l</a>`;
    expect(plainText(html)).toBe("A&B Rolling back x l");
    expect(headings(html)).toEqual(["Rolling back"]);
    expect(pageLinks(html)).toEqual(["abcdefgh"]);
    expect(blocks(html)).toEqual(["<p>A&amp;B</p>", "<h2>Rolling <em>back</em></h2>", "<ul><li>x</li></ul>", `<a href="/pages/abcdefgh#top">l</a>`]);
  });
});

describe("Markdown", () => {
  it("goes both ways with tables and code", () => {
    const md = "## Ports\n\n| Service | Port |\n| --- | --- |\n| api | 8080 |\n\n```sh\nmake run\n```\n\nSee [deploy](/pages/abcdefgh).\n";
    const html = toHtml(md, "markdown");
    expect(html).toContain('<code class="language-sh">');
    expect(toMarkdown(html)).toBe(md);
  });

  it("imports front matter, a first heading or the file name as the title", () => {
    expect(importFile("x.md", "---\ntitle: From front matter\n---\nBody", "markdown")).toEqual({ title: "From front matter", html: "<p>Body</p>" });
    expect(importFile("x.md", "# Heading\n\nBody", "markdown")).toEqual({ title: "Heading", html: "<p>Body</p>" });
    expect(importFile("dir/paging_rules.md", "Body", "markdown").title).toBe("paging rules");
    expect(importFile("a.html", "<html><head><title>T</title></head><body><h1>T</h1><p>B<script>x</script></p></body></html>", "html")).toEqual({
      title: "T",
      html: "<p>B</p>",
    });
  });
});
