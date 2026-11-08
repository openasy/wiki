import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zip } from "./zip.ts";

/** Reads the archive back by its central directory, as an unzip tool does. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + buf.readUInt16LE(offset + 26);
    out[name] = inflateRawSync(buf.subarray(start, start + size)).toString("utf8");
    at += 46 + nameLength;
  }
  return out;
}

describe("zip", () => {
  it("writes entries an unzip tool reads back, with UTF-8 names", () => {
    const z = zip([
      { path: "İnsan/İzin.md", data: Buffer.from("# İzin\n") },
      { path: "İnsan/files/a.txt", data: Buffer.from("x".repeat(1000)) },
    ]);
    expect(unzip(z)).toEqual({ "İnsan/İzin.md": "# İzin\n", "İnsan/files/a.txt": "x".repeat(1000) });
  });
});
