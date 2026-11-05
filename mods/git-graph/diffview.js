// How a diff looks, shared by the PR dialog (git-remote) and the commit dialog (git-graph): the color presets,
// the row, and the syntax colors. Mirror: identical in both mods (a mod cannot import another mod's files).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { tokenize, languageOf } from "./highlight.js";

// Diff colors, cycled from the diff header and remembered. null add/del = the theme's green/red; `a` is the tint's alpha (hex).
export const DIFF_PALETTES = [
  { id: "theme", label: "主題", add: null, del: null, a: "18" },
  { id: "vivid", label: "鮮明", add: null, del: null, a: "33" },
  { id: "github", label: "GitHub", add: "#2ea043", del: "#f85149", a: "26" },
  { id: "cb", label: "藍橘（色盲友善）", add: "#388bfd", del: "#f0883e", a: "2e" },
];

export function diffColors(id, t) {
  const p = DIFF_PALETTES.find((x) => x.id === id) ?? DIFF_PALETTES[0];
  return { ...p, add: p.add ?? t.ansi2, del: p.del ?? t.ansi1 };
}

export const nextPaletteId = (id) => DIFF_PALETTES[(DIFF_PALETTES.findIndex((x) => x.id === id) + 1) % DIFF_PALETTES.length].id;

export function loadPaletteId(key) {
  try { return localStorage.getItem(key) ?? "theme"; } catch { return "theme"; }
}

export function savePaletteId(key, id) {
  try { localStorage.setItem(key, id); } catch { /* memory only */ }
}

// Token classes → the theme's colors, so the code follows the user's theme.
export const syntaxColors = (t) => ({
  keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3,
  number: t.ansi1, boolean: t.ansi1, variable: t.ansi6,
});

// Tokenizes a file's rows once, when the file is picked, so a frame only draws the rows on screen. A block comment or
// multi-line string carries into the next row. Rows of a language without a tokenizer stay plain (no `spans`).
export function tokenizeRows(rows, path) {
  const lang = languageOf(path);
  if (!lang || rows.tokenized) return rows;
  rows.tokenized = true;
  let state = null;
  for (const r of rows) {
    if (r.kind === "@") { state = null; continue; }
    const t = tokenize(r.text.replace(/\t/g, "    "), lang, state);
    r.spans = t.spans; state = t.state;
  }
  return rows;
}

// One diff row: gutter bar and number tinted by kind, the text syntax-colored when it has `spans`.
export function diffRow({ kind, number, text, spans }, t, c, colors, rowH) {
  if (kind === "@") return div().w_full().px(12).h(rowH).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  const tone = kind === "+" ? c.add : kind === "-" ? c.del : null;
  const body = spans
    ? h_flex().flex_1().min_w(0).pl(10).whitespace_nowrap()
        .children(spans.map((s) => s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text)))
    : div().flex_1().min_w(0).pl(10).truncate().child(text);
  return h_flex().w_full().h(rowH).flex_none()
    .when(Boolean(tone), (e) => e.bg(tone + c.a))
    .child(div().w(3).h_full().flex_none().when(Boolean(tone), (e) => e.bg(tone)))
    .child(div().w(40).flex_none().text_right().text_color(tone ?? t.dim).child(number === undefined ? "" : String(number)))
    .child(body);
}
