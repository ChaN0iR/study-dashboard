import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const link = html.match(/<a\b(?=[^>]*\bid="recall-room-shortcut")[^>]*>[\s\S]*?<\/a>/);

test("recall shortcut keeps its accessible disabled state and uses a line-art card icon", () => {
  assert.ok(link, "recall shortcut exists");
  assert.match(link[0], /\bclass="icon-btn"/);
  assert.match(link[0], /\baria-label="回想室"/);
  assert.match(link[0], /\btitle="回想室"/);
  assert.match(link[0], /\baria-disabled="true"/);
  assert.doesNotMatch(link[0], /\bhref=/);
  assert.doesNotMatch(link[0], /<span\b[^>]*>回<\/span>/);

  const svg = link[0].match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/);
  assert.ok(svg, "shortcut contains an SVG icon");
  const attrs = svg[1];
  assert.match(attrs, /\bviewBox="0 0 24 24"/);
  assert.match(attrs, /\bwidth="22"/);
  assert.match(attrs, /\bheight="22"/);
  assert.match(attrs, /\bfill="none"/);
  assert.match(attrs, /\bstroke="currentColor"/);
  assert.match(attrs, /\bstroke-width="1\.8"/);
  assert.match(attrs, /\bstroke-linecap="round"/);
  assert.match(attrs, /\bstroke-linejoin="round"/);
  assert.match(attrs, /\baria-hidden="true"/);
  assert.match(svg[2], /<rect\b[^>]*\brx="2(?:\.\d+)?"/);
  assert.match(svg[2], /<path\b/);
  assert.match(svg[2], /M9\.5 9a2\.5 2\.5/);
  assert.match(svg[2], /M12 17\.5v\.1/);
  assert.doesNotMatch(svg[2], />[^<]+</);
 });

test("the currentColor line icon follows the light and dark theme foreground", () => {
  assert.match(css, /:root\{[^}]*--fg:#161616/);
  assert.match(css, /@media\s*\(prefers-color-scheme:dark\)\s*\{\s*:root\{[^}]*--fg:#ececea/);
  assert.match(link?.[0] ?? "", /stroke="currentColor"/);
});
