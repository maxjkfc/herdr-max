import * as fs from "fs/promises";
import { appHome, exec } from "herdr";

// Avatars and the pictures in issue bodies. Herdr's markdown view draws no images, so a body is
// split into text and pictures (split), and each picture is fetched once into data/github/ (want).

const IMAGE = /\[?!\[([^\]]*)\]\(<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\)(?:\]\([^)]*\))?|<img\s[^>]*>/gi;
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']?([^"'\\s>]+)`, "i").exec(tag)?.[1];

// Markdown → [{ text } | { image, alt, width }], in order. Fenced code stays text.
export function split(markdown) {
  const parts = [];
  let lines = [], fence = null;
  const flush = () => { if (lines.join("").trim()) parts.push({ text: lines.join("\n") }); lines = []; };
  for (const line of String(markdown ?? "").split("\n")) {
    const mark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (mark || fence) {
      if (mark) fence = fence === mark ? null : fence ?? mark;
      lines.push(line);
      continue;
    }
    let from = 0;
    for (const m of line.matchAll(IMAGE)) {
      const src = m[2] ?? attr(m[0], "src");
      if (!src || !/^https?:\/\//.test(src)) continue;
      lines.push(line.slice(from, m.index));
      flush();
      parts.push({ image: src, alt: m[1] ?? attr(m[0], "alt") ?? "", width: Number(attr(m[0], "width")) || null });
      from = m.index + m[0].length;
    }
    lines.push(line.slice(from));
  }
  flush();
  return parts;
}

// Pixel size from `file` (PNG, JPEG, GIF, WebP), else an SVG's own width/height or viewBox.
export function sizeOf(description, head = "") {
  const all = [...String(description).matchAll(/(\d+)\s*x\s*(\d+)/g)], last = all.at(-1); // JPEG says "density 72x72" first
  if (last && !/svg/i.test(description)) return { width: +last[1], height: +last[2] };
  const svg = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!svg) return null;
  const w = parseFloat(attr(svg, "width")), h = parseFloat(attr(svg, "height"));
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  const box = /viewBox\s*=\s*["']([^"']+)/i.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return box?.length === 4 && box[2] > 0 && box[3] > 0 ? { width: Math.round(box[2]), height: Math.round(box[3]) } : null;
}

const known = new Map(); // key → "loading" | "missing" | { path, file, width?, height? }
const nameOf = (s) => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };

async function fetchTo(url, file) {
  // Private attachments need the gh token: it goes only to github.com, on stdin (printf is a shell
  // builtin, so never on a command line), and curl drops it on GitHub's redirect to its storage host.
  const get = /^https:\/\/github\.com\//.test(url)
    ? 'printf "Authorization: token %s\\n" "$(gh auth token)" | curl -fsSL --max-time 30 -H @- -o "$1" "$2"'
    : 'curl -fsSL --max-time 30 -o "$1" "$2"';
  const r = await exec("sh", ["-c", `${get} || { rm -f "$1"; exit 1; }`, "sh", file, url]).catch(() => null);
  return r?.code === 0;
}

async function measure(file) {
  const r = await exec("file", ["-b", file]).catch(() => null);
  const head = r?.stdout.includes("SVG") || !r ? (await fs.readFile(file, "utf8").catch(() => "")).slice(0, 4000) : "";
  return sizeOf(r?.stdout ?? "", head);
}

// The file for `url` once it's on disk, "missing", or null while it loads. The first call starts the
// download and also returns `pending`, a promise that settles when it's done (to redraw then).
export function want(url, { dir = "images", key = url, sized = true } = {}) {
  const got = known.get(key);
  if (got !== undefined) return { got: got === "loading" ? null : got };
  known.set(key, "loading");
  const pending = (async () => {
    const path = `data/github/${dir}/${nameOf(key)}.png` /* the loader sniffs the format; the extension only has to be one it knows */, file = `${appHome()}/${path}`;
    try {
      if (!await fs.exists(file)) {
        await fs.mkdir(`${appHome()}/data/github/${dir}`, { recursive: true });
        if (!await fetchTo(url, file)) throw new Error("download failed");
      }
      const size = sized ? await measure(file) : {};
      if (!size) throw new Error("not an image");
      known.set(key, { path, file, ...size });
    } catch { known.set(key, "missing"); }
  })();
  return { got: null, pending };
}

// A login's avatar: the timeline's URL when there is one, else github.com/<login>.png. Apps have none.
export const avatar = (login, url) => /^app\//.test(login) && !url ? { got: "missing" }
  : want(url ?? `https://github.com/${login}.png?size=80`, { dir: "avatars", key: `@${login}`, sized: false });
