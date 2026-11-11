// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };
const GLYPH = { error: "!", warning: "!", success: "✓", info: "i" };

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const level = p.level ?? "info";
    const tone = t[DOT[level] ?? "accent"];

    return h_flex()
      .id("toast")
      .size_full()
      .items_center()
      .bg(t.popover)
      .rounded(10)
      .border_1()
      .border_color(tone)
      .overflow_hidden()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      // Thick accent strip on the left, coloured by level.
      .child(div().w(5).h_full().flex_none().bg(tone))
      .child(
        h_flex()
          .flex_1()
          .h_full()
          .px(14)
          .gap(12)
          .items_center()
          .overflow_hidden()
          .child(
            p.icon
              ? image(p.icon).w(26).h(26).flex_none()
              : div()
                  .size(26)
                  .rounded(13)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .bg(tone)
                  .text_size(15)
                  .font_bold()
                  .text_color(t.background)
                  .child(GLYPH[level] ?? "i"),
          )
          .child(
            v_flex()
              .flex_1()
              .overflow_hidden()
              .gap(2)
              .child(div().truncate().font_bold().text_size(15).text_color(t.foreground).child(p.title ?? ""))
              .when(Boolean(p.body), (el) =>
                el.child(div().truncate().text_size(13).text_color(t.muted).child(p.body ?? "")),
              ),
          ),
      );
  }
}
