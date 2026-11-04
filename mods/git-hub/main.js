import { View, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { layout, run, shared, setShared, theme } from "herdr";

const TABS = [
  ["changes", "Changes", "mods/changes/changes.svg"],
  ["graph", "Graph", "mods/tabs-plus/graph.svg"],
  ["prs", "PRs", "mods/github/icons/pr-open.svg"],
  ["issues", "Issues", "mods/github/icons/issue-open.svg"],
  ["actions", "CI", "mods/github/icons/actions.svg"],
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

export function selectGitTab(id) {
  setShared("git.subtab", id);
  if (id === "changes" || id === "graph") {
    setShared("git.focus", { target: id, at: Date.now() });
    run("layout.select", { stack: "git-body", child: id });
  } else {
    setShared("github.tab", id);
    setShared("git.focus", { target: "github", at: Date.now() });
    run("layout.select", { stack: "git-body", child: "github" });
  }
}

export default class GitHubSwitcher extends View {
  render() {
    const t = theme();
    const body = find(layout(), "git-body");
    const stackActive = body?.active ?? "changes";
    const ghTab = shared("github.tab") ?? "prs";
    const active = stackActive === "github" ? (["prs", "issues", "actions"].includes(ghTab) ? ghTab : "prs") : stackActive;

    return v_flex().id("git-switcher").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(8).gap(3).items_center().border_b(1).border_color(t.border)
        .children(TABS.map(([id, label, icon]) => {
          const on = active === id;
          return h_flex().id(`git-sub-${id}`).h(28).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
            .bg(on ? t.selected : "#00000000").hover((s) => s.bg(on ? t.selected : t.hover))
            .text_size(12.5).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
            .on_click(() => selectGitTab(id))
            .child(svg(icon).size(13.5).flex_none().text_color(on ? t.accent : t.muted))
            .child(label);
        })));
  }
}
