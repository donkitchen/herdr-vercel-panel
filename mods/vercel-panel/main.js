// vercel-panel: Vercel deploys beside your agents.
// Roles (props.role): the panel (default) polls Vercel, draws, toasts and owns the ask-agent
// queue; "toggle" is the top-bar button; "peek" is the build-log dialog Enter opens (ui/peek.js).
// It only reads from Vercel. It never runs vercel switch/login/link, and every call names its team.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  exec, run, theme, settings, layout, panes, spaces, notify, shared, setShared, nextCommand,
  readTextFile, writeTextFile, appHome, openOverlay, props as blockProps,
} from "herdr";
import { parseConfig } from "./config.js";
import { collapseAction } from "./collapse.js";
import {
  withLogin, tokenArgs, apiArgs, USER_PATH, TEAMS_PATH, deploymentsPath, projectsPath,
  parseUser, parseTeams, parseProjects, parseDeployments, mergeDeploys, vercelError, authFile, hasToken, pickPath, authPathFor,
} from "./vercel.js";
import { buildView, siteUrl, formatAgo, nextOf } from "./model.js";
import { decide, markOpened, emptyState } from "./seen.js";
import { askMessage, findAgent, spaceForRepo, sendDecision } from "./agent.js";
import { renderPanel, rowOrder, DAY_CHIPS } from "./ui/panel.js";
import { Peek, PEEK_ASK } from "./ui/peek.js";
import { openWebUrl } from "./ui/open.js";

const MOD = "vercel-panel";
const FILTERS = "vercel-panel.filters"; // the chip choices, remembered across restarts
const COUNT = "vercel-panel.count"; // {inFlight, failed}, for the toggle
const SELECT = "vercel-panel.select"; // a row id the panel should select (set when a toast is posted)
const OPENED = "vercel-panel.opened"; // a failed deploy id the peek opened
const SLOW_EVERY_MS = 10 * 60 * 1000; // logins, teams and projects
const TICK_MS = 5000; // redraw elapsed times while something builds
const MAX_LINE = 120;

const configPath = () => `${appHome()}/vercel-panel.json`;
const statePath = () => `${appHome()}/vercel-panel.state.json`;
const clip = (s) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
const fontSize = () => Number(settings()?.ui_font_size) || 13;

/** The panel's layout node: the block showing this mod whose role isn't "toggle". */
export function panelNode(node = layout()) {
  if (!node || typeof node !== "object") return null;
  const c = node.content;
  if (node.type === "block" && c?.mod === MOD && (c.props?.role ?? "panel") !== "toggle") return node;
  for (const child of node.children ?? []) {
    const found = panelNode(child);
    if (found) return found;
  }
  return null;
}

function parseState(text) {
  try {
    const s = text ? JSON.parse(text) : null;
    if (s && typeof s === "object") {
      const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
      return { initialized: s.initialized === true, teams: ids(s.teams), final: ids(s.final), opened: ids(s.opened) };
    }
  } catch { /* unreadable: start over quietly (a first run never toasts) */ }
  return emptyState();
}

let lastCollapse = null;

function toggle() {
  const t = theme();
  const act = collapseAction(layout(), panelNode()?.id);
  const key = act ? `${act.op}:${act.id}` : null;
  if (key && key !== lastCollapse) run(`layout.${act.op}`, { id: act.id });
  lastCollapse = key;
  const c = shared(COUNT) ?? {};
  const n = (Number(c.inFlight) || 0) + (Number(c.failed) || 0);
  const red = (Number(c.failed) || 0) > 0;
  const node = panelNode();
  const on = node && !node.hidden;
  const size = fontSize();
  return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-vercel-panel").h(26).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(size - 1).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { const p = panelNode(); if (p?.id) run("layout.toggle", { id: p.id }); })
      .child("Deploys")
      .child(h_flex().h(18).min_w(18).px(6).flex_none().justify_center().items_center().rounded(9)
        .bg(red ? t.ansi1 : n > 0 ? t.accent : t.raised).text_size(size - 2).font_semibold()
        .text_color(red || n > 0 ? t.accent_foreground : t.muted).child(String(n))));
}

/**
 * Phase 2 hook (design doc, "Phase 2"): every push group that just reached a final state,
 * toasted or not. Day one does nothing here; telling the branch's agent plugs in here.
 */
function onGroupFinal(_groups, _config) {}

export default class VercelPanel extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "peek") { this.peek = new Peek(cx); return; }
    if (this.role !== "panel") return;

    this.handle = cx.focus_handle();
    this.config = parseConfig(null).config;
    this.configProblem = null;
    this.env = null; // {home, platform, envToken}
    this.logins = []; // {login, token} usable now
    this.loginNotes = []; // lines for logins that can't be used
    this.teams = [];
    this.me = new Set();
    this.projects = new Map(); // teamId -> Project[]
    this.deploys = new Map(); // teamId -> Deploy[] (last good per team)
    this.slowAt = 0;
    this.view = null;
    this.selectedId = null;
    this.selectedIndex = 0;
    this.lastSelect = shared(SELECT) ?? null;
    this.lastOpened = shared(OPENED) ?? null;
    this.lastAsk = shared(PEEK_ASK) ?? null;
    this.stale = false;
    this.messages = [];
    this.note = null;
    this.checkedAt = null;
    this.loading = true;
    this.inFlight = false;
    this.state = emptyState();
    this.stateText = null;
    this.stateChain = Promise.resolve();
    this.interval = null;
    this.timer = null;
    this.filters = null; // {days, team, target, mine}; read from FILTERS once config is loaded
    this.asks = []; // {deployId, terminal, text}: waiting for that agent to be idle

    cx.spawn(async (cx) => {
      await this.loadConfig();
      await this.refresh(cx);
    });
    this.jobs = [];
    this.wake = null;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.jobs.length === 0) await new Promise((resolve) => { this.wake = resolve; });
        this.wake = null;
        const job = this.jobs.shift();
        if (!job) continue;
        try { await job(cx); } catch (e) { console.log(`${MOD}: ${e?.stack ?? e}`); }
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.handle.focus();
        cx.notify();
      }
    });
    cx.timer.every(TICK_MS, (cx) => {
      if (this.asks.length) this.pumpAsks();
      if (this.view?.count.inFlight) { this.rebuild(); cx.notify(); }
    });
  }

  /** Work found during render or a key runs on the panel's own task (render's cx ends with the frame). */
  later(job) {
    this.jobs.push(job);
    if (this.wake) this.wake();
  }

  // ---- Config, state ----

  async loadConfig() {
    let text = null;
    try { text = await readTextFile(configPath()); } catch { text = null; }
    const { config, problem } = parseConfig(text);
    this.config = config;
    this.configProblem = problem;
  }

  locked(fn) {
    const r = this.stateChain.then(fn, fn);
    this.stateChain = r.catch(() => {});
    return r;
  }

  loadState() {
    return this.locked(async () => {
      try { this.stateText = await readTextFile(statePath()); } catch { this.stateText = null; }
      const file = parseState(this.stateText);
      // Keep what memory knows on top of the file (a failed save must not forget ids).
      this.state = {
        initialized: file.initialized || this.state.initialized,
        teams: [...new Set([...(file.teams ?? []), ...(this.state.teams ?? [])])],
        final: [...new Set([...file.final, ...this.state.final])],
        opened: [...new Set([...file.opened, ...this.state.opened])],
      };
    });
  }

  updateState(change) {
    return this.locked(async () => {
      this.state = change(this.state);
      const text = `${JSON.stringify(this.state, null, 2)}\n`;
      if (text === this.stateText) return;
      try {
        await writeTextFile(statePath(), text, this.stateText);
        this.stateText = text;
      } catch {
        try {
          this.stateText = await readTextFile(statePath());
          await writeTextFile(statePath(), text, this.stateText);
          this.stateText = text;
        } catch (e) { console.log(`${MOD}: could not save ${statePath()}: ${e?.message ?? e}`); }
      }
    });
  }

  schedule(cx) {
    const busy = Boolean(this.view?.count.inFlight);
    const ms = (this.config.refresh_seconds ?? (busy ? 30 : 60)) * 1000;
    if (this.timer && this.interval === ms) return;
    if (this.timer) this.timer.cancel();
    this.interval = ms;
    this.timer = cx.timer.every(ms, (cx) => { this.refresh(cx); });
  }

  // ---- Vercel ----

  async loadEnv() {
    if (this.env) return this.env;
    const r = await exec("sh", ["-c", 'printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s" "$HOME" "$(uname -s)" "${VERCEL_TOKEN:+1}" "${SHELL:-/bin/sh}" "$(command -v vercel)" "$(command -v hc)"']);
    const [home, uname, tok, shell, foundVercel, foundHc] = r.stdout.split("\n");
    // Herdr's PATH can miss where these live (pnpm, npm prefixes, ~/.local/bin): ask the login shell once.
    const viaShell = async (name) => pickPath((await exec(shell, ["-ilc", `command -v ${name}`], { timeout: 15000 }).catch(() => ({ stdout: "" }))).stdout);
    const vercel = pickPath(foundVercel) ?? await viaShell("vercel");
    const hc = pickPath(foundHc) ?? await viaShell("hc");
    this.env = { home, platform: /darwin/i.test(uname) ? "darwin" : "linux", envToken: tok === "1", vercel, hc };
    return this.env;
  }

  /** Runs one API call as a login. Throws {code, stdout, stderr}. */
  async api(entry, path) {
    const bin = this.env?.vercel;
    if (!bin) throw { code: 127, stdout: "", stderr: "Vercel CLI not found: install it (npm i -g vercel) and run vercel login" };
    // Every call: a logout in a terminal must never leave the panel starting login flows.
    const authPath = this.env ? authPathFor(entry.login, this.env) : null;
    if (authPath) {
      let text = null;
      try { text = await readTextFile(authPath); } catch { text = null; }
      if (!hasToken(text)) throw { code: 1, stdout: "", stderr: "No existing credentials found." };
    }
    let r;
    try { r = await exec(bin, withLogin(entry.login, apiArgs(path), entry.token), { timeout: 30000 }); }
    catch (e) { throw { code: 127, stdout: "", stderr: `couldn't run vercel: ${e?.message ?? e}` }; }
    if (r.code !== 0) throw r;
    try { return JSON.parse(r.stdout); }
    catch { throw { code: 1, stdout: "", stderr: `vercel returned something that isn't JSON: ${(r.stdout || "").slice(0, 80)}` }; }
  }

  /**
   * Which logins can be used. A login with no credentials file is never called: the CLI would
   * start a browser login flow in the background.
   */
  async loadLogins() {
    const env = await this.loadEnv();
    const wanted = [{ name: "default" }, ...this.config.accounts.map((a) => ({ name: a.name, globalConfig: a.global_config, tokenKeychain: a.token_keychain }))];
    const usable = [];
    const notes = [];
    for (const login of wanted) {
      if (login.tokenKeychain) {
        const r = await exec("security", tokenArgs(login.tokenKeychain)).catch(() => ({ code: 1, stdout: "" }));
        const token = r.code === 0 ? r.stdout.trim() : "";
        if (token) usable.push({ login, token });
        else notes.push(`${login.name}: no Keychain item "${login.tokenKeychain}"`);
        continue;
      }
      const path = authPathFor(login, env);
      if (!path) { usable.push({ login, token: null }); continue; }
      let text = null;
      try { text = await readTextFile(path); } catch { text = null; }
      if (hasToken(text)) usable.push({ login, token: null });
      else if (login.name === "default") notes.push("Vercel CLI isn't logged in: run vercel login");
      else notes.push(`${login.name}: not logged in: run vercel login -Q ${login.globalConfig}`);
    }
    return { usable, notes };
  }

  /** Logins, who "you" are, teams and projects: at start and every 10 minutes. */
  async loadSlow() {
    const { usable, notes } = await this.loadLogins();
    const me = new Set(this.config.me);
    const teams = [];
    const seen = new Set();
    const projects = new Map();
    for (const entry of usable) {
      try {
        const u = parseUser(await this.api(entry, USER_PATH));
        if (u.username) me.add(u.username);
        if (u.githubLogin) me.add(u.githubLogin);
        for (const t of parseTeams(await this.api(entry, TEAMS_PATH), entry.login.name)) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          teams.push({ team: t, entry });
        }
      } catch (e) {
        notes.push(`${entry.login.name === "default" ? "Vercel" : entry.login.name}: ${vercelError(e).line}`);
      }
    }
    for (const { team, entry } of teams) {
      try { projects.set(team.id, parseProjects(await this.api(entry, projectsPath(team.id)), team.id)); }
      catch (e) { notes.push(`${team.name}: ${vercelError(e).line}`); }
    }
    this.logins = usable;
    this.loginNotes = notes;
    if (teams.length || usable.length === 0) {
      this.teams = teams;
      this.me = me;
      for (const [id, ps] of projects) this.projects.set(id, ps);
    }
    this.slowAt = Date.now();
  }

  async refresh(cx) {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.loadConfig();
      if (!this.teams.length || Date.now() - this.slowAt >= SLOW_EVERY_MS) await this.loadSlow();
      await this.loadState();
      const lines = [...this.loginNotes];
      let ok = 0;
      for (const { team, entry } of this.teams) {
        try {
          this.deploys.set(team.id, parseDeployments(await this.api(entry, deploymentsPath(team.id)), team));
          ok++;
        } catch (e) { lines.push(`${team.name}: ${vercelError(e).line}`); }
      }
      this.messages = lines.map(clip);
      this.stale = this.teams.length > 0 && ok < this.teams.length;
      if (ok === 0) return; // nothing new: keep the last view and the toast memory as they are
      const all = mergeDeploys([...this.deploys.values()]);
      const r = decide(all, this.state, this.config, this.me);
      await this.updateState(() => r.state);
      this.rebuild();
      this.toast(r.toasts);
      if (r.finals.length) onGroupFinal(r.finals, this.config);
      this.checkedAt = Date.now();
    } catch (e) {
      console.log(`${MOD}: refresh failed: ${e?.stack ?? e}`);
      this.stale = true;
      this.messages = [clip(e?.code !== undefined ? vercelError(e).line : String(e?.message ?? e))];
    } finally {
      this.inFlight = false;
      this.loading = false;
      this.schedule(cx);
      cx.notify();
    }
  }

  /** The chip choices: saved ones, else the config's window and no other filter. */
  filt() {
    if (!this.filters) {
      const saved = shared(FILTERS);
      const days = DAY_CHIPS.includes(saved?.days) ? saved.days : this.config.projects.recent_days;
      this.filters = {
        days,
        team: typeof saved?.team === "string" ? saved.team : null,
        target: saved?.target === "production" || saved?.target === "preview" ? saved.target : null,
        mine: saved?.mine === true,
      };
    }
    return this.filters;
  }

  setFilter(patch) {
    this.filters = { ...this.filt(), ...patch };
    setShared(FILTERS, this.filters);
    this.selectedId = null;
    this.selectedIndex = 0;
    this.rebuild();
  }

  rebuild() {
    const all = mergeDeploys([...this.deploys.values()]);
    const projects = [...this.projects.values()].flat();
    this.view = buildView(all, projects, this.config, new Set(this.state.opened), Date.now(), this.teams.map((x) => x.team), {
      recentDays: this.filt().days,
      team: this.teams.some((x) => x.team.id === this.filt().team) ? this.filt().team : null,
      target: this.filt().target,
      mine: this.filt().mine ? this.me : null,
    });
    const c = this.view.count;
    const prev = shared(COUNT);
    if (!prev || prev.inFlight !== c.inFlight || prev.failed !== c.failed) setShared(COUNT, c);
    const rows = rowOrder(this.view);
    if (this.selectedId && !rows.some((r) => r.id === this.selectedId)) {
      this.selectedId = rows.length ? rows[Math.min(this.selectedIndex, rows.length - 1)].id : null;
    }
    this.selectedIndex = Math.max(0, rows.findIndex((r) => r.id === this.selectedId));
  }

  toast(toasts) {
    const node = panelNode();
    for (const t of toasts) {
      const n = { title: t.title, body: t.body, level: t.level };
      if (node?.id) n.action = { name: "layout.show", args: { id: node.id } };
      setShared(SELECT, t.select);
      notify(n);
    }
  }

  // ---- Keys and actions ----

  selected() {
    return rowOrder(this.view).find((r) => r.id === this.selectedId) ?? null;
  }

  select(id) {
    this.selectedId = id;
    this.selectedIndex = Math.max(0, rowOrder(this.view).findIndex((r) => r.id === id));
  }

  move(delta) {
    const rows = rowOrder(this.view);
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.id === this.selectedId);
    const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta));
    this.select(rows[next].id);
  }

  /** The deploy a row stands for: a failed one, a group's first, or a project's newest preview. */
  deployOf(row) {
    if (!row) return null;
    if (row.kind === "failed") return row.deploy;
    if (row.kind === "group") return row.group.deploys[0];
    return row.row.preview ?? null;
  }

  loginFor(d) {
    return this.teams.find((x) => x.team.id === d.team.id)?.entry ?? null;
  }

  open(url, cx) { openWebUrl(url, cx); }

  openSite(which, cx) {
    const row = this.selected();
    if (!row) return;
    const url = row.kind === "project" ? siteUrl(row.row, which) : siteUrl(this.deployOf(row));
    if (url) this.open(url, cx);
    else this.note = which === "preview" ? "No preview for this project yet" : "No address for this one";
  }

  openVercel(cx) {
    const row = this.selected();
    if (!row) return;
    if (row.kind === "project") {
      const team = this.teams.find((x) => x.team.id === row.row.project.teamId)?.team;
      if (team) this.open(`https://vercel.com/${team.slug}/${row.row.project.name}`, cx);
      return;
    }
    const d = this.deployOf(row);
    if (d?.inspectorUrl) this.open(d.inspectorUrl, cx);
  }

  goToAgent() {
    const d = this.deployOf(this.selected());
    if (!d) return;
    const pane = findAgent(d, panes());
    if (pane) { run("pane.focus", { terminal: pane.terminal }); return; }
    const space = spaceForRepo(d.repo, spaces());
    if (space) run("space.select", { id: space.id });
    else this.note = d.repo ? `No agent or space for ${d.repo.repo}` : "No branch to find an agent by";
  }

  /** Opens the build-log dialog. The deploy and the login's flags go over as plain JSON. */
  peekSelected() {
    const d = this.deployOf(this.selected());
    if (!d) return;
    const entry = this.loginFor(d);
    openOverlay({ mod: MOD, kind: "dialog", width: 0.9, height: 0.9,
      props: { role: "peek", vercel: this.env?.vercel ?? "vercel", authPath: this.env ? authPathFor(entry?.login ?? { name: "default" }, this.env) : null, deploy: JSON.parse(JSON.stringify(d)), login: entry?.login ?? { name: "default" }, failed: d.state === "error" } });
    if (d.state === "error") this.markOpened(d.id);
  }

  markOpened(id) {
    this.later(async () => {
      await this.updateState((s) => markOpened(s, id));
      this.rebuild();
    });
  }

  /**
   * `a` on a failed deploy: the agent on its branch gets the message once it's idle; with no
   * agent there, a new one starts in the repo's space with the message as its first task.
   */
  ask(d) {
    if (this.asks.some((a) => a.deployId === d.id)) { this.note = "Already waiting for that agent"; return; }
    const text = askMessage(d, new Date(d.readyAt ?? d.created));
    const pane = findAgent(d, panes());
    if (pane) {
      this.asks.push({ deployId: d.id, terminal: pane.terminal, text });
      run("pane.focus", { terminal: pane.terminal });
      this.pumpAsks();
      return;
    }
    const space = spaceForRepo(d.repo, spaces());
    if (!space) { this.note = `No space for ${d.repo?.repo ?? d.project}: open one, then press a`; return; }
    run("tab.new", { space: space.id, folder: space.folder || undefined, argv: this.config.agent.argv, task: text });
    this.note = `Asked a new agent in ${space.name}`;
    this.markOpened(d.id);
  }

  /** Sends queued messages to agents that are idle now; drops ones whose agent is gone. */
  pumpAsks() {
    const now = panes();
    for (const entry of [...this.asks]) {
      const what = sendDecision(entry, now);
      if (what === "wait") continue;
      this.asks = this.asks.filter((a) => a !== entry);
      if (what === "drop") { this.note = "Agent ended before it got the message"; continue; }
      this.later(async () => {
        const bin = this.env?.hc;
        if (!bin) { this.note = "Couldn't find hc (Herdr's terminal tool) to send the message"; return; }
        const r = await exec(bin, ["send", entry.terminal, entry.text]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
        if (r.code !== 0) { this.note = clip(`Couldn't send to the agent: ${(r.stderr || r.stdout || "").trim()}`); return; }
        this.note = "Sent to the agent";
        await this.updateState((s) => markOpened(s, entry.deployId));
        this.rebuild();
      });
    }
  }

  onKey(e, cx) {
    const k = e.key;
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    this.note = null;
    if (k === "up") this.move(-1);
    else if (k === "down") this.move(1);
    else if (k === "enter") this.peekSelected();
    else if (k === "v") this.openSite(e.modifiers?.shift ? "preview" : "prod", cx);
    else if (k === "V") this.openSite("preview", cx);
    else if (k === "o") this.openVercel(cx);
    else if (k === "g") this.goToAgent();
    else if (k === "a") { const row = this.selected(); if (row?.kind === "failed") this.ask(row.deploy); else this.note = "a works on a failed deploy"; }
    else if (k === "h") this.setFilter({ days: nextOf(DAY_CHIPS, this.filt().days) });
    else if (k === "t") this.setFilter({ team: nextOf([null, ...this.teams.map((x) => x.team.id)], this.filt().team) });
    else if (k === "p") this.setFilter({ target: nextOf([null, "production", "preview"], this.filt().target) });
    else if (k === "m") this.setFilter({ mine: !this.filt().mine });
    else if (k === "r") this.later(async (cx) => { this.slowAt = 0; await this.refresh(cx); });
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  async close(_cx) {
    if (this.peek) this.peek.dispose();
  }

  // ---- Drawing ----

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (this.role === "peek") return this.peek.render(cx);
    if (this.role !== "panel") return div();
    const t = theme();

    const want = shared(SELECT) ?? null;
    if (want !== this.lastSelect) {
      this.lastSelect = want;
      if (want) this.select(want);
    }
    const opened = shared(OPENED) ?? null;
    if (opened !== this.lastOpened) {
      this.lastOpened = opened;
      if (opened) this.markOpened(String(opened).split("@")[0]);
    }
    const ask = shared(PEEK_ASK) ?? null;
    if (ask !== this.lastAsk) {
      this.lastAsk = ask;
      if (ask) {
        const id = String(ask).split("@")[0];
        const d = (this.view?.failed ?? []).find((x) => x.id === id) ?? mergeDeploys([...this.deploys.values()]).find((x) => x.id === id);
        if (d) this.later(async () => this.ask(d));
      }
    }

    const multiTeam = (this.view?.teams.length ?? 0) > 1 || this.teams.length > 1;
    const lines = [...(this.configProblem ? [this.configProblem] : []), ...this.messages, ...(this.note ? [this.note] : [])];
    const ui = {
      selectedId: this.selectedId,
      now: Date.now(),
      stale: this.stale,
      messages: lines,
      checkedAgo: this.checkedAt ? (Date.now() - this.checkedAt < 60000 ? "just now" : `${formatAgo(Date.now() - this.checkedAt)} ago`) : null,
      loading: this.loading,
      size: fontSize(),
      multiTeam,
      filters: this.filt(),
      teamList: this.teams.map((x) => ({ id: x.team.id, name: x.team.name })),
      onFilter: (patch, cx) => { this.setFilter(patch); cx.notify(); },
      queued: new Set(this.asks.map((a) => a.deployId)),
      onSelect: (id, cx) => { if (id === this.selectedId) { this.peekSelected(); return; } this.select(id); this.handle.focus(); cx.notify(); },
      onOpen: (url, cx) => this.open(url, cx),
    };
    return v_flex().id("vercel-panel").size_full().min_h(0).track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(renderPanel(this.view, ui, t));
  }
}
