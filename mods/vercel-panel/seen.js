// Pure module: which push groups just finished, and which of those toast. One toast per group,
// never twice. The first run records what's already finished and toasts nothing.
import { groupKey, isBot, isMuted, latestPerProject, teamAllowed, projectAllowed } from "./model.js";

const KEEP = 500;
const FINAL = new Set(["ready", "error"]);

export const emptyState = () => ({ initialized: false, teams: [], final: [], opened: [] });

const lc = (s) => String(s ?? "").toLowerCase();
const short = (sha) => (sha ? sha.slice(0, 7) : "");

function toastFor(ds, cfg, me) {
  const first = ds[0];
  const n = ds.length;
  const label = first.branch ?? first.project;
  const errors = ds.filter((d) => d.state === "error");
  if (errors.length > 0) {
    return {
      title: n > 1 ? `${label}: ${errors.length} of ${n} failed` : `${first.project} deploy failed`,
      body: errors.map((d) => d.project).join(", "),
      level: "error",
      select: errors[0].id,
    };
  }
  if (ds.every((d) => isMuted(d, cfg))) return null;
  const body = first.branch ? `${first.branch} · ${short(first.sha)}` : (first.url ?? "");
  const select = `p:${first.projectId}`; // ui/panel.js projectRowId: the push has left "building now"
  if (first.target === "production") {
    if (isBot(first.pusher, cfg)) return null;
    return { title: n > 1 ? `${label}: ${n} of ${n} live` : `${first.project} is live`, body, level: "success", select };
  }
  if (!first.pusher || !me.has(lc(first.pusher))) return null;
  return { title: n > 1 ? `${label}: ${n} of ${n} ready` : `${first.project} preview ready`, body, level: "success", select };
}

/**
 * @param {any[]} deploys every deploy fetched
 * @param {{initialized:boolean, final:string[], opened:string[]}} state
 * @param {any} cfg
 * @param {Set<string>} me logins counted as "you" (any case)
 * @returns {{toasts:any[], finals:{key:string, team:any, branch:string|null, deploys:any[]}[], state:any}}
 */
export function decide(deploys, state, cfg, me) {
  const meLc = new Set([...me].map(lc));
  // Excluded teams and projects never toast (and their teams count as unseen if included later).
  const shown = deploys.filter((d) => teamAllowed(d.team, cfg) && projectAllowed(d.team.slug, d.project, cfg));
  // A team's first list is recorded quietly, like the first run: a new or recovered team
  // must not toast its whole history.
  const knownTeams = new Set(state.initialized ? (state.teams ?? []) : []);
  const groups = new Map();
  for (const d of shown) {
    if (d.state === "canceled") continue;
    const k = groupKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const known = new Set(state.final);
  const added = [];
  const toasts = [];
  const finals = [];
  for (const [key, all] of groups) {
    const ds = latestPerProject(all);
    if (!ds.every((d) => FINAL.has(d.state))) continue;
    const fresh = ds.filter((d) => !known.has(d.id));
    if (fresh.length === 0) continue;
    for (const d of fresh) { known.add(d.id); added.push(d.id); }
    for (const d of all) if (!known.has(d.id)) { known.add(d.id); added.push(d.id); } // replaced by a redeploy
    if (!knownTeams.has(ds[0].team.id)) continue;
    finals.push({ key, team: ds[0].team, branch: ds[0].branch, deploys: fresh });
    const t = toastFor(fresh, cfg, meLc);
    if (t) toasts.push(t);
  }

  const present = new Set(deploys.map((d) => d.id));
  const all = [...state.final, ...added];
  const tail = new Set(all.slice(-KEEP));
  const final = all.filter((id) => present.has(id) || tail.has(id));
  const teams = [...new Set([...(state.initialized ? (state.teams ?? []) : []), ...shown.map((d) => d.team.id)])];
  return { toasts, finals, state: { initialized: true, teams, final, opened: state.opened.slice() } };
}

export function markOpened(state, id) {
  if (state.opened.includes(id)) return state;
  return { ...state, opened: [...state.opened, id].slice(-KEEP) };
}
