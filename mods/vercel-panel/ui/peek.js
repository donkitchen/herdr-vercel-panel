// The peek dialog: one deploy's summary and build log, over the window.
// Opened by the panel with openOverlay({mod:"vercel-panel", kind:"dialog", props:{role:"peek",
// deploy, login, vercel, failed}}). Read-only: it runs `vercel inspect --logs` and nothing else.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, theme, settings, props, closeOverlay, setShared, readTextFile } from "herdr";
import { withLogin, tokenArgs, inspectLogsArgs, logLines, firstErrorLine, vercelError, hasToken } from "../vercel.js";
import { formatElapsed, formatAgo } from "../model.js";
import { openWebUrl } from "./open.js";

/** The peek's `a`: asks the panel to ask an agent about this deploy ("<deployId>@<time>"). */
export const PEEK_ASK = "vercel-panel.peek-ask";

const ROW = 20;
const STEP = 3;
const fontSize = () => Number(settings()?.ui_font_size) || 13;
const STATE_WORD = { ready: "ready", error: "failed", building: "building", queued: "queued", canceled: "canceled" };

export class Peek {
  constructor(cx) {
    const p = props() ?? {};
    this.d = p.deploy ?? null;
    this.login = p.login ?? { name: "default" };
    this.bin = p.vercel ?? "vercel";
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.focusedOnce = false;
    cx.timer.after(600, () => { if (!this.handle.is_focused()) this.handle.focus(); });
    this.scroll = VirtualListScrollHandle.new();
    this.top = 0;
    this.page = 20;
    this.lines = null;
    this.error = null;
    this.width = 300;
    if (!this.d) return;
    cx.spawn(async (cx) => {
      try {
        let token = null;
        if (this.login.tokenKeychain) {
          const r = await exec("security", tokenArgs(this.login.tokenKeychain));
          token = r.code === 0 ? r.stdout.trim() : null;
        }
        const authPath = props()?.authPath;
        if (authPath) {
          let text = null;
          try { text = await readTextFile(authPath); } catch { text = null; }
          if (!hasToken(text)) throw new Error("Vercel CLI isn't logged in: run vercel login");
        }
        const r = await exec(this.bin, withLogin(this.login, inspectLogsArgs(this.d), token), { timeout: 60000 });
        // The log arrives on stderr, and a failed build exits 1: only no log at all is an error.
        const lines = logLines(`${r.stdout}\n${r.stderr}`);
        if (lines.length === 0 && r.code !== 0) this.error = vercelError(r).line;
        this.lines = lines;
        this.width = Math.max(300, Math.min(4000, Math.max(0, ...lines.map((l) => l.length)) * 7.5 + 40));
        const at = firstErrorLine(lines.join("\n"));
        if (props()?.failed && at > 0) cx.timer.after(50, (cx) => { this.scrollTo(Math.max(0, at - 2)); cx.notify(); });
      } catch (e) {
        this.error = /time(d)? ?out/i.test(String(e?.message ?? e)) ? "Vercel took over a minute: press o to open it there" : String(e?.message ?? e);
        this.lines = [];
      }
      cx.notify();
    });
  }

  close() { closeOverlay(props()?.overlay); }

  dispose() {
    try { this.scroll.release(); } catch { /* already released */ }
  }

  scrollTo(top) {
    const n = this.lines?.length ?? 0;
    if (n === 0) return;
    const next = Math.max(0, Math.min(top, Math.max(0, n - this.page)));
    const down = next > this.top;
    this.top = next;
    this.scroll.scroll_to_item(down ? Math.min(n - 1, next + this.page - 1) : next, "top");
  }

  ask() {
    if (this.d?.state !== "error") return;
    setShared(PEEK_ASK, `${this.d.id}@${Date.now()}`);
    this.close();
  }

  onKey(e, cx) {
    const k = e.key;
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    if (k === "escape") this.close();
    else if (k === "down" || k === "j") this.scrollTo(this.top + STEP);
    else if (k === "up" || k === "k") this.scrollTo(this.top - STEP);
    else if (k === "space") this.scrollTo(this.top + (e.modifiers?.shift ? -1 : 1) * Math.max(1, this.page - 2));
    else if (k === "pagedown") this.scrollTo(this.top + Math.max(1, this.page - 2));
    else if (k === "pageup") this.scrollTo(this.top - Math.max(1, this.page - 2));
    else if (k === "home") this.scrollTo(0);
    else if (k === "end") this.scrollTo(Infinity);
    else if (k === "v") openWebUrl(this.d?.url, cx);
    else if (k === "o") openWebUrl(this.d?.inspectorUrl, cx);
    else if (k === "a") this.ask();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  header(t, size) {
    const d = this.d;
    const color = d.state === "ready" ? t.ansi2 : d.state === "error" ? t.ansi1 : t.ansi3;
    const took = d.readyAt ? formatElapsed(d.readyAt - d.startedAt) : `${formatElapsed(Date.now() - d.startedAt)} so far`;
    const meta = h_flex().flex_wrap().gap_x(14).gap_y(2).items_center().text_size(size - 1).text_color(t.muted)
      .child(div().flex_none().child(d.team.name))
      .child(div().flex_none().child(d.target === "production" ? "production" : "preview"))
      .when(Boolean(d.branch), (el) => el.child(div().flex_none().child(`${d.branch} · ${String(d.sha ?? "").slice(0, 7)}`)))
      .when(Boolean(d.pusher), (el) => el.child(div().flex_none().child(d.pusher)))
      .child(div().flex_none().child(took))
      .child(div().flex_none().text_color(t.dim).child(`${formatAgo(Date.now() - d.created)} ago`));
    return v_flex().flex_none().px(18).pt(14).pb(10).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(size + 3).font_semibold().text_color(t.foreground).child(d.project))
        .child(div().flex_none().text_color(color).child(STATE_WORD[d.state] ?? d.state)))
      .child(meta);
  }

  log(t, size) {
    const lines = this.lines;
    let inner;
    if (lines === null) inner = div().p(14).text_color(t.dim).child("Loading the build log…");
    else if (this.error) inner = div().p(14).text_color(t.ansi1).child(this.error);
    else if (lines.length === 0) inner = div().p(14).text_color(t.dim).child("No build log yet.");
    else {
      const errAt = firstErrorLine(lines.join("\n"));
      inner = div().id("peek-log-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.width).h_full()
          .child(v_virtual_list("peek-log", lines.length, ROW, (i) => String(i),
            (range) => lines.slice(range.start, range.end).map((l, j) => {
              const i = range.start + j;
              const bad = /\b(error|failed|ERR!)\b/i.test(l);
              return div().w_full().h(ROW).flex_none().px(14).flex().items_center().truncate()
                .text_color(bad ? t.ansi1 : t.foreground).when(i === errAt, (el) => el.bg(t.raised)).child(l || " ");
            }))
            .track_scroll(this.scroll).size_full()));
    }
    return div().id("peek-log-area").flex_1().min_h(0).relative()
      .font_family(settings()?.font_family ?? "JetBrains Mono").text_size(size - 1)
      .on_size_change((s, cx) => {
        const page = Math.max(1, Math.floor(s.height / ROW));
        if (page !== this.page) { this.page = page; cx.notify(); }
      })
      .child(inner)
      .when(Boolean(lines && lines.length && !this.error), (el) => el.child(Scrollbar.vertical("peek-log").viewport_from_layout().absolute().inset_0()));
  }

  render(_cx) {
    const t = theme();
    const size = fontSize();
    const root = v_flex().id("vercel-peek").size_full().min_h(0).bg(t.popover ?? t.surface).text_size(size).text_color(t.foreground)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((_s, _cx) => { if (!this.focusedOnce) { this.focusedOnce = true; this.handle.focus(); } });
    if (!this.d) return root.child(div().p(18).text_color(t.dim).child("No deploy to show."));
    const hints = div().flex_none().h(28).px(18).flex().items_center().border_t(1).border_color(t.border)
      .text_size(size - 2).text_color(t.dim).truncate()
      .child(`↑↓ j k scroll · space page${this.d.state === "error" ? " · a ask agent" : ""} · v site · o Vercel · Esc close`);
    return root.child(this.header(t, size)).child(this.log(t, size)).child(hints);
  }
}
