// Draws the panel from a View (model.js buildView). No fetching here: main.js owns state and
// passes callbacks in `ui`.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { formatElapsed, formatAgo, siteUrl } from "../model.js";

const MAX_LINE = 120;
const clip = (s) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
const stop = (_e, cx) => cx.stop_propagation();

export const projectRowId = (projectId) => `p:${projectId}`;

/** Selectable rows in drawn order: failures, building groups, then projects. Up/Down walks this. */
export function rowOrder(view) {
  const rows = [];
  for (const d of view?.failed ?? []) rows.push({ id: d.id, kind: "failed", deploy: d });
  for (const g of view?.building ?? []) rows.push({ id: g.key, kind: "group", group: g });
  for (const t of view?.teams ?? []) for (const r of t.rows) rows.push({ id: projectRowId(r.project.id), kind: "project", row: r });
  return rows;
}

const MARK = { ready: "●", building: "◐", queued: "○", error: "✕" };
const stateColor = (t, s) => (s === "ready" ? t.ansi2 : s === "error" ? t.ansi1 : s === "building" ? t.ansi3 : t.dim);
const slowColor = (t, slow) => (slow === "late" ? t.ansi1 : slow === "warn" ? t.ansi3 : t.dim);

function mark(t, state, size) {
  return div().flex_none().w(size).text_size(size - 1).text_color(stateColor(t, state)).child(MARK[state] ?? "·")
    .when(state === "building", (c) => c.loop("opacity", { from: 0.35, to: 1, period: 1400 }));
}

function tag(t, text, size, color) {
  return div().flex_none().px(5).rounded(4).bg(t.raised).text_size(size - 2).text_color(color ?? t.muted).child(text);
}

function link(id, t, label, url, size, ui) {
  return div().id(id).flex_none().text_size(size - 1).text_color(url ? t.accent : t.dim)
    .when(Boolean(url), (el) => el.cursor_pointer().hover((s) => s.underline()).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); ui.onOpen(url, cx); }))
    .child(label);
}

function line(id, selected, t, size, ui) {
  return h_flex().id(`row-${id}`).min_h(size + 13).px(12).gap(6).items_center().cursor_pointer()
    .bg(selected ? t.selected : t.surface).hover((s) => s.bg(selected ? t.selected : t.hover))
    .on_click((_e, cx) => ui.onSelect(id, cx));
}

function failedRow(d, ui, t, size) {
  const selected = ui.selectedId === d.id;
  const queued = ui.queued?.has(d.id);
  const el = line(d.id, selected, t, size, ui)
    .child(mark(t, "error", size))
    .child(div().flex_none().text_color(t.foreground).child(d.project))
    .when(ui.multiTeam, (e) => e.child(tag(t, d.team.slug, size)))
    .child(div().flex_1().min_w(0).truncate().text_size(size - 1).text_color(t.muted)
      .child(`${d.target === "production" ? "prod" : "preview"}${d.branch ? ` · ${d.branch}` : ""}`))
    .when(Boolean(queued), (e) => e.child(tag(t, "queued for agent", size, t.ansi3)))
    .child(div().flex_none().text_size(size - 1).text_color(t.ansi1).child(`failed ${formatAgo(ui.now - (d.readyAt ?? d.created))}`));
  if (!selected) return el;
  return v_flex().child(el).child(div().px(12).pl(12 + size + 6).pb(6).bg(t.selected).text_size(size - 1.5).text_color(t.dim)
    .child("⏎ log · a ask agent · v site · o Vercel"));
}

function groupRow(g, ui, t, size) {
  const selected = ui.selectedId === g.key;
  const state = g.deploys.some((d) => d.state === "building") ? "building" : "queued";
  const el = line(g.key, selected, t, size, ui)
    .child(mark(t, state, size))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(g.label))
    .when(ui.multiTeam, (e) => e.child(tag(t, g.team.slug, size)))
    .when(g.total > 1, (e) => e.child(div().flex_none().text_size(size - 1).text_color(t.muted).child(`${g.ready} of ${g.total} ready`)))
    .child(div().flex_none().text_size(size - 1).text_color(slowColor(t, g.slow)).child(formatElapsed(g.elapsedMs)));
  if (!selected && g.total === 1) return el;
  const kids = g.deploys.map((d) => h_flex().px(12).pl(12 + size + 6).gap(6).items_center()
    .child(mark(t, d.state, size))
    .child(div().flex_1().min_w(0).truncate().text_size(size - 1).text_color(t.foreground).child(d.project))
    .child(div().flex_none().text_size(size - 1.5).text_color(t.dim).child(d.state === "ready" ? "ready" : d.state === "error" ? "failed" : `${d.state}…`))
    .child(link(`site-${d.id}`, t, "↗", siteUrl(d), size, ui)));
  return v_flex().child(el).child(v_flex().pb(4).gap(1).bg(selected ? t.selected : t.surface).children(kids));
}

function projectRow(r, ui, t, size) {
  const id = projectRowId(r.project.id);
  const selected = ui.selectedId === id;
  const ago = (ms) => formatAgo(ui.now - ms);
  const prodCell = h_flex().gap(4).items_center()
    .child(div().flex_none().text_size(size - 1.5).text_color(t.dim).child("prod"))
    .child(r.prod ? mark(t, r.prod.state, size) : div().text_color(t.dim).child("—"))
    .when(Boolean(r.prod), (e) => e.child(div().flex_none().text_size(size - 1.5).text_color(t.dim).child(ago(r.prod.created))))
    .child(link(`prod-${r.project.id}`, t, "↗", siteUrl(r, "prod"), size, ui));
  const p = r.preview;
  const previewCell = h_flex().flex_1().min_w(0).gap(4).items_center()
    .child(div().flex_none().text_size(size - 1.5).text_color(t.dim).child("preview"))
    .child(p ? mark(t, p.state, size) : div().text_color(t.dim).child("—"))
    .when(Boolean(p), (e) => e
      .child(div().min_w(0).truncate().text_size(size - 1.5).text_color(t.muted).child(p.branch ?? ""))
      .child(div().flex_none().text_size(size - 1.5).text_color(t.dim).child(ago(p.created)))
      .child(link(`preview-${r.project.id}`, t, "↗", siteUrl(r, "preview"), size, ui)));
  return v_flex().id(`row-${id}`).px(12).py(4).gap(2).cursor_pointer()
    .bg(selected ? t.selected : t.surface).hover((s) => s.bg(selected ? t.selected : t.hover))
    .on_click((_e, cx) => ui.onSelect(id, cx))
    .child(div().truncate().text_color(t.foreground).child(r.project.name))
    .child(h_flex().gap(12).items_center().child(prodCell).child(previewCell));
}

/** Time windows the first chip group cycles through; 0 is "All". */
export const DAY_CHIPS = [1, 7, 30, 0];
const dayLabel = (n) => (n === 0 ? "All" : n === 1 ? "24h" : `${n}d`);

function chip(id, t, label, on, size, onClick) {
  return div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(11).cursor_pointer()
    .text_size(size - 1.5).border_1().border_color(on ? t.accent : t.border)
    .bg(on ? t.accent : t.surface).text_color(on ? t.accent_foreground : t.muted)
    .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(label);
}

const gap = () => div().flex_none().w(6);

/** The filter chips: time window, team (2+ teams), target, mine. One click each. */
function chips(ui, t, size) {
  const f = ui.filters;
  const set = (patch) => (cx) => ui.onFilter(patch, cx);
  const row = h_flex().flex_none().flex_wrap().gap_x(4).gap_y(4).px(12).py(6).items_center().border_b(1).border_color(t.border);
  for (const n of DAY_CHIPS) row.child(chip(`chip-d${n}`, t, dayLabel(n), f.days === n, size, set({ days: n })));
  if (ui.teamList.length > 1) {
    row.child(gap());
    row.child(chip("chip-t-all", t, "All teams", !f.team, size, set({ team: null })));
    for (const tm of ui.teamList) row.child(chip(`chip-t-${tm.id}`, t, tm.name, f.team === tm.id, size, set({ team: f.team === tm.id ? null : tm.id })));
  }
  row.child(gap());
  row.child(chip("chip-prod", t, "Prod", f.target === "production", size, set({ target: f.target === "production" ? null : "production" })));
  row.child(chip("chip-preview", t, "Preview", f.target === "preview", size, set({ target: f.target === "preview" ? null : "preview" })));
  row.child(gap());
  row.child(chip("chip-mine", t, "Mine", f.mine, size, set({ mine: !f.mine })));
  return row;
}

function header(t, label, size, first) {
  return div().flex_none().px(12).pt(first ? 8 : 12).pb(4).text_size(size - 1.5).font_semibold().text_color(t.muted).truncate().child(label);
}

/**
 * @param {any} view buildView result, or null before the first load
 * @param {{selectedId:string|null, now:number, stale:boolean, messages:string[], checkedAgo:string|null,
 *   loading:boolean, size:number, multiTeam:boolean, queued:Set<string>,
 *   onSelect:(id:string, cx:any)=>void, onOpen:(url:string, cx:any)=>void}} ui
 */
export function renderPanel(view, ui, t) {
  const size = ui.size ?? 13;
  const busy = view ? view.count.inFlight : 0;
  const failed = view ? view.count.failed : 0;
  const status = ui.loading && !view ? "checking…" : ui.checkedAgo ? `checked ${ui.checkedAgo}` : "";
  const top = h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().flex_none().text_size(size + 1).font_semibold().text_color(t.foreground).child("Deploys"))
    .when(busy > 0, (e) => e.child(tag(t, `${busy} building`, size, t.ansi3)))
    .when(failed > 0, (e) => e.child(tag(t, `${failed} failed`, size, t.ansi1)))
    .when(ui.stale, (e) => e.child(tag(t, "stale", size)))
    .child(h_flex().flex_1().min_w(0).justify_end()
      .child(div().min_w(0).truncate().text_size(size - 1.5).text_color(ui.stale ? t.ansi3 : t.dim).child(status)));

  const msgs = ui.messages.filter(Boolean);
  const messageArea = v_flex().flex_none().px(12).py(msgs.length ? 6 : 0).gap(2)
    .when(msgs.length > 0, (el) => el.border_b(1).border_color(t.border))
    .children(msgs.map((m) => div().truncate().text_size(size - 1).text_color(t.ansi3).child(clip(m))));

  const blocks = [];
  if (view && (view.failed.length || view.building.length)) {
    blocks.push(header(t, "BUILDING NOW", size, true));
    for (const d of view.failed) blocks.push(failedRow(d, ui, t, size));
    for (const g of view.building) blocks.push(groupRow(g, ui, t, size));
  }
  if (view && view.teams.length) {
    blocks.push(header(t, "PROJECTS", size, blocks.length === 0));
    for (const tm of view.teams) {
      if (ui.multiTeam) blocks.push(header(t, tm.team.name, size, false));
      for (const r of tm.rows) blocks.push(projectRow(r, ui, t, size));
    }
  }
  if (view && view.hiddenOld > 0) {
    const n = view.hiddenOld;
    blocks.push(div().px(12).pt(10).text_size(size - 1.5).text_color(t.dim)
      .child(`${n} project${n === 1 ? "" : "s"} quiet for ${dayLabel(ui.filters.days)} hidden · h for a wider window`));
  }

  const filtering = ui.filters.team || ui.filters.target || ui.filters.mine;
  const body = blocks.length > 0
    ? div().id("deploy-list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().pb(8).children(blocks))
    : v_flex().flex_1().min_h(0).justify_center().items_center().text_color(t.dim)
      .child(view ? (filtering ? "Nothing matches these filters." : "No deploys yet.") : ui.loading ? "Checking Vercel…" : "");

  const hints = div().flex_none().h(28).px(12).flex().items_center().border_t(1).border_color(t.border)
    .text_size(size - 2).text_color(t.dim).truncate().child("⏎ log · v site · o Vercel · a ask agent · h t p m filters · r refresh");

  return v_flex().size_full().min_h(0).bg(t.surface).text_size(size).text_color(t.foreground)
    .child(top).child(messageArea).child(chips(ui, t, size)).child(body).child(hints);
}
