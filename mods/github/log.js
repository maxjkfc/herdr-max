// A failed run's log cut to what an agent needs: the error lines with their lead-up,
// without timestamps, colors or the runner's own bookkeeping.
const NOISE = /^(##\[(group|endgroup|start-action|end-action)|\[command\]|shell: |Cleaning up orphan|Post job cleanup|  [A-Z_]+: |env:$)|git (config|submodule)/;
const ERROR = /##\[error\]|\[ERROR\]|\berror(\[E\d+\])?:|panicked at|\bFAILED\b|\bFAIL\b|✗|Traceback|AssertionError|exit code [1-9]/i;

export function trimLog(raw, max = 80) {
  const lines = String(raw).split("\n").map((l) => {
    const [job, , ...rest] = l.split("\t");
    const text = rest.join("\t").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").trimEnd();
    return { job, text };
  }).filter((l) => l.text.trim() && !NOISE.test(l.text));
  const hits = lines.map((l, n) => ERROR.test(l.text) ? n : -1).filter((n) => n >= 0);
  const [from, to] = hits.length ? [Math.max(0, hits[0] - 25), Math.min(lines.length, hits.at(-1) + 3)] : [Math.max(0, lines.length - 60), lines.length];
  const cut = lines.slice(Math.max(from, to - max), to);
  return cut.map((l) => `${l.job} | ${l.text}`).join("\n");
}
