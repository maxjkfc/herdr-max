// Unified `diff --git` text → [{ path, add, del, binary, rows: [{ kind: "@"|"+"|"-"|" ", number?, text }] }].
// Only lines after a file's first `@@` are content, so a removed line "-- x" (shown as "--- x") is a row, not a header.
export function parseDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
    const file = { path: m ? m[2] : (lines[0] ?? "").trim(), add: 0, del: 0, binary: false, rows: [] };
    let oldLine = 0, newLine = 0, inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { file.binary = true; continue; }
      if (line.startsWith("@@")) {
        const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hm) { oldLine = Number(hm[1]); newLine = Number(hm[2]); }
        inHunk = true;
        file.rows.push({ kind: "@", text: line });
      } else if (!inHunk) continue;
      else if (line.startsWith("+")) { file.add++; file.rows.push({ kind: "+", number: newLine++, text: line.slice(1) }); }
      else if (line.startsWith("-")) { file.del++; file.rows.push({ kind: "-", number: oldLine++, text: line.slice(1) }); }
      else if (line.startsWith(" ")) { oldLine++; file.rows.push({ kind: " ", number: newLine++, text: line.slice(1) }); }
    }
    files.push(file);
  }
  return files;
}
