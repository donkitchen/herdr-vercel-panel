// Pure module: turns deploys and projects into what the panel draws.
// Canceled deploys never appear. Muted deploys leave "building now" and toasts, never failures.

const IN_FLIGHT = new Set(["queued", "building"]);
const lc = (s) => String(s ?? "").toLowerCase();

/** A push: same team, repo, branch, commit and target. Deploys without a commit stand alone. */
export function groupKey(d) {
  if (!d.sha) return d.id;
  const repo = d.repo ? `${d.repo.org}/${d.repo.repo}` : "";
  return `${d.team.id}|${repo}|${d.branch ?? ""}|${d.sha}|${d.target}`;
}

/** The newest deploy of each project (a redeploy of the same commit replaces the older one). */
export function latestPerProject(ds) {
  const seen = new Set();
  return ds.slice().sort((a, b) => b.created - a.created).filter((d) => {
    const k = d.projectId || d.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function isBot(login, cfg) {
  if (!login) return false;
  if (/\[bot\]$/i.test(login)) return true;
  return cfg.bots.some((b) => lc(b) === lc(login));
}

export function isMuted(d, cfg) {
  if (d.state === "error") return false;
  return cfg.mute.some((r) =>
    (r.project === undefined || lc(r.project) === lc(d.project))
    && (r.author === undefined || lc(r.author) === lc(d.pusher))
    && (r.target === undefined || r.target === d.target));
}

/** Median build time of the project's last 10 successful builds, or null with fewer than 3. */
export function typicalMs(deploys, projectId) {
  const times = deploys
    .filter((d) => d.projectId === projectId && d.state === "ready" && d.readyAt)
    .sort((a, b) => b.created - a.created)
    .slice(0, 10)
    .map((d) => d.readyAt - d.startedAt)
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  const mid = times.length >> 1;
  return times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
}

export function slowLevel(elapsedMs, typical, slow) {
  if (!typical) return null;
  if (elapsedMs >= typical * slow.late) return "late";
  if (elapsedMs >= typical * slow.warn) return "warn";
  return null;
}

const RANK = { late: 2, warn: 1 };
const worse = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

export function teamAllowed(team, cfg) {
  const names = [lc(team.slug), lc(team.id)];
  if (cfg.teams.include && !cfg.teams.include.some((t) => names.includes(lc(t)))) return false;
  return !cfg.teams.exclude.some((t) => names.includes(lc(t)));
}

export function projectAllowed(teamSlug, name, cfg) {
  return !cfg.projects.exclude.some((p) => lc(p) === lc(name) || lc(p) === `${lc(teamSlug)}/${lc(name)}`);
}

/**
 * @param {any[]} deploys every deploy fetched (all teams, newest first or not)
 * @param {any[]} projects every project fetched
 * @param {any} cfg parsed config
 * @param {Set<string>} opened failed deploy ids the user has opened
 * @param {number} now ms
 * @param {any[]} [teams] known teams, for project rows of teams with no deploys in the list
 * @param {{recentDays?:number, team?:string|null, target?:string|null, mine?:Set<string>|null}} [opts]
 *   the panel's filter chips. They change what is shown; `count` (the top-bar number) always covers
 *   everything, so a failure in a team you aren't looking at still reaches you.
 */
export function buildView(deploys, projects, cfg, opened, now, teams = [], opts = {}) {
  const teamById = new Map();
  for (const t of teams) teamById.set(t.id, t);
  for (const d of deploys) if (!teamById.has(d.team.id)) teamById.set(d.team.id, d.team);

  const visible = deploys
    .filter((d) => d.state !== "canceled" && teamAllowed(d.team, cfg) && projectAllowed(d.team.slug, d.project, cfg))
    .sort((a, b) => b.created - a.created);

  // Building now: groups with something in flight; muted deploys left out.
  const groups = new Map();
  for (const d of visible) {
    if (isMuted(d, cfg)) continue;
    const k = groupKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const building = [];
  let inFlight = 0;
  for (const [key, all] of groups) {
    const ds = latestPerProject(all);
    const flying = ds.filter((d) => IN_FLIGHT.has(d.state));
    if (flying.length === 0) continue;
    inFlight += flying.length;
    const start = Math.min(...ds.map((d) => d.startedAt));
    let slow = null;
    for (const d of flying) slow = worse(slow, slowLevel(now - d.startedAt, typicalMs(deploys, d.projectId), cfg.slow));
    building.push({
      key, label: ds[0].branch ?? ds[0].project, team: ds[0].team, deploys: ds,
      ready: ds.filter((d) => d.state === "ready").length, total: ds.length,
      elapsedMs: Math.max(0, now - start), slow,
    });
  }

  // Failed: until opened, or until a later deploy of the same project and branch succeeds.
  const failed = visible.filter((d) => d.state === "error" && !opened.has(d.id)
    && !visible.some((o) => o.state === "ready" && o.projectId === d.projectId && o.branch === d.branch && o.created > d.created));

  // Projects, grouped by team, newest activity first; quiet ones past recent_days are counted, not shown.
  const activity = (r) => Math.max(r.prod?.created ?? 0, r.preview?.created ?? 0);
  const days = opts.recentDays ?? cfg.projects.recent_days;
  const cutoff = days > 0 ? now - days * 86400000 : -Infinity;
  const mineSet = opts.mine ? new Set([...opts.mine].map((x) => String(x).toLowerCase())) : null;
  let hiddenOld = 0;
  const byTeam = new Map();
  for (const p of projects) {
    const team = teamById.get(p.teamId);
    if (!team || !teamAllowed(team, cfg) || !projectAllowed(team.slug, p.name, cfg)) continue;
    if (opts.team && team.id !== opts.team) continue;
    if (mineSet && !visible.some((d) => d.projectId === p.id && mineSet.has(String(d.pusher ?? "").toLowerCase()))) continue;
    const preview = visible.find((d) => d.projectId === p.id && d.target === "preview") ?? null;
    // The project record is refreshed every 10 minutes; a newer live deploy in the list wins.
    const live = visible.find((d) => d.projectId === p.id && d.target === "production" && d.state === "ready");
    const prod = live && live.created > (p.prod?.created ?? 0) ? { url: live.url, state: "ready", created: live.created } : p.prod;
    const row = {
      project: p,
      prod: opts.target === "preview" ? null : prod,
      preview: opts.target === "production" ? null : preview,
    };
    if (opts.target === "production" && !row.prod) continue;
    if (opts.target === "preview" && !row.preview) continue;
    if (activity(row) < cutoff) { hiddenOld++; continue; }
    if (!byTeam.has(team.id)) byTeam.set(team.id, { team, rows: [] });
    byTeam.get(team.id).rows.push(row);
  }
  const order = [...teamById.keys()];
  const teamRows = [...byTeam.values()]
    .sort((a, b) => order.indexOf(a.team.id) - order.indexOf(b.team.id))
    .map((t) => ({ team: t.team, rows: t.rows.sort((a, b) => activity(b) - activity(a)) }));

  const count = { inFlight, failed: failed.length };
  const mine = opts.mine ? new Set([...opts.mine].map((x) => String(x).toLowerCase())) : null;
  const shown = (d) => (!opts.team || d.team.id === opts.team)
    && (!opts.target || d.target === opts.target)
    && (!mine || mine.has(String(d.pusher ?? "").toLowerCase()));
  return {
    building: building.filter((g) => shown(g.deploys[0])),
    failed: failed.filter(shown),
    teams: teamRows,
    hiddenOld,
    count,
  };
}

/** The site to open: a deploy's own URL, or a project row's prod or preview address. */
export function siteUrl(target, which) {
  if (!target) return null;
  if (target.project && typeof target.project === "object") {
    if (which === "preview") return target.preview ? (target.preview.branchAlias ?? target.preview.url) : null;
    return target.project.prodUrl ?? target.prod?.url ?? null;
  }
  return target.url ?? null;
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A short age for list cells: now, 16m, 5h, 5d. */
export function formatAgo(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The value after `cur` in a cycle of chip values (the first when `cur` isn't in it). */
export function nextOf(list, cur) {
  const i = list.indexOf(cur);
  return list[(i + 1) % list.length];
}
