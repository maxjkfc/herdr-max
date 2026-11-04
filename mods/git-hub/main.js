import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { layout, run, shared, setShared, theme } from "herdr";

const TABS = [
  ["changes", "Changes", "mods/changes/changes.svg"],
  ["graph", "Graph", "mods/tabs-plus/graph.svg"],
  ["github", "Remote", "mods/github/icons/pr-open.svg"],
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

export default class GitHubSwitcher extends View {
  render() {
    const t = theme();
    const body = find(layout(), "git-body");
    const active = body?.active ?? shared("git.subtab") ?? "changes";
    return v_flex().id("git-switcher").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .children(TABS.map(([id, label, icon]) => {
          const on = active === id;
          return h_flex().id(`git-sub-${id}`).h(28).px(10).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
            .bg(on ? t.selected : "#00000000").hover((s) => s.bg(on ? t.selected : t.hover))
            .text_size(13).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
            .on_click(() => {
              setShared("git.subtab", id);
              run("layout.select", { stack: "git-body", child: id });
            })
            .child(svg(icon).size(14).flex_none().text_color(on ? t.accent : t.muted))
            .child(label);
        })));
  }
}
