// Pure module: Vercel CLI argument builders, API paths, response parsing, error mapping.
// Nothing here runs a program or touches the network. Every API path names its team, because
// without teamId the CLI falls back to whatever team it last switched to.

/** @typedef {{ name:string, globalConfig?:string, tokenKeychain?:string }} Login   // "default" = the CLI's own login */
/** @typedef {{ id:string, slug:string, name:string, login:string }} Team */
/** @typedef {"queued"|"building"|"ready"|"error"|"canceled"} State */
/** @typedef {{ id:string, name:string, teamId:string, repo:{org:string,repo:string}|null,
 *   prodUrl:string|null, prod:{url:string, state:State, created:number}|null }} Project */
/** @typedef {{ id:string, team:Team, project:string, projectId:string, url:string, inspectorUrl:string,
 *   state:State, target:"production"|"preview", created:number, startedAt:number, readyAt:number|null,
 *   branch:string|null, sha:string|null, pusher:string|null, branchAlias:string|null,
 *   repo:{org:string,repo:string}|null }} Deploy */

export const USER_PATH = "/v2/user";
export const TEAMS_PATH = "/v2/teams?limit=100";
export const deploymentsPath = (teamId) => `/v6/deployments?teamId=${encodeURIComponent(teamId)}&limit=50`;
export const projectsPath = (teamId) => `/v9/projects?teamId=${encodeURIComponent(teamId)}&limit=100`;
export const apiArgs = (path) => ["api", path, "--non-interactive"];

/** Appends the flags that make one call run as `login`. The default login gets nothing. */
export function withLogin(login, args, token) {
  const out = args.slice();
  if (login?.globalConfig) out.push("-Q", login.globalConfig);
  if (token) out.push("--token", token);
  return out;
}

/** Arguments for `security` that print a Keychain password (the token) for `service`. */
export const tokenArgs = (service) => ["find-generic-password", "-s", service, "-w"];

/** Where a login's credentials live. The CLI starts a login flow when this has no token. */
export function authFile(home, platform, globalConfig) {
  if (globalConfig) return `${globalConfig.replace(/\/+$/, "")}/auth.json`;
  if (platform === "darwin") return `${home}/Library/Application Support/com.vercel.cli/auth.json`;
  return `${home}/.local/share/com.vercel.cli/auth.json`;
}

export function hasToken(text) {
  if (typeof text !== "string") return false;
  try {
    const j = JSON.parse(text);
    return typeof j?.token === "string" && j.token !== "";
  } catch { return false; }
}

const str = (v) => (typeof v === "string" && v !== "" ? v : null);
const https = (host) => (str(host) ? (/^https?:\/\//i.test(host) ? host : `https://${host}`) : null);

export function parseUser(json) {
  const u = json?.user ?? {};
  return { username: str(u.username), githubLogin: str(u.githubLogin) };
}

export function parseTeams(json, login) {
  const list = Array.isArray(json?.teams) ? json.teams : [];
  return list.filter((t) => str(t?.id) && str(t?.slug))
    .map((t) => ({ id: t.id, slug: t.slug, name: str(t.name) ?? t.slug, login }));
}

const STATES = { QUEUED: "queued", INITIALIZING: "queued", BUILDING: "building", READY: "ready", ERROR: "error", CANCELED: "canceled" };
const mapState = (s) => STATES[String(s ?? "").toUpperCase()] ?? "queued";

export function parseProjects(json, teamId) {
  const list = Array.isArray(json?.projects) ? json.projects : [];
  return list.filter((p) => str(p?.id) && str(p?.name)).map((p) => {
    const link = p.link ?? {};
    const repo = link.type === "github" && str(link.org) && str(link.repo) ? { org: link.org, repo: link.repo } : null;
    const t = p.targets?.production ?? null;
    const aliases = Array.isArray(t?.alias) ? t.alias.filter((a) => typeof a === "string") : [];
    const host = aliases.find((a) => !a.endsWith(".vercel.app")) ?? aliases[0] ?? null;
    const prod = t && str(t.url) ? { url: https(t.url), state: mapState(t.readyState), created: Number(t.createdAt) || 0 } : null;
    return { id: p.id, name: p.name, teamId, repo, prodUrl: https(host), prod };
  });
}

export function parseDeployments(json, team) {
  const list = Array.isArray(json?.deployments) ? json.deployments : [];
  return list.filter((d) => str(d?.uid)).map((d) => {
    const m = d.meta ?? {};
    const git = str(m.githubCommitSha) !== null;
    const created = Number(d.created) || 0;
    return {
      id: d.uid,
      team,
      project: str(d.name) ?? "",
      projectId: str(d.projectId) ?? "",
      url: https(d.url),
      inspectorUrl: str(d.inspectorUrl),
      state: mapState(d.readyState ?? d.state),
      target: d.target === "production" ? "production" : "preview",
      created,
      startedAt: Number(d.buildingAt) || created,
      readyAt: Number(d.ready) || null,
      branch: git ? str(m.githubCommitRef) : null,
      sha: git ? m.githubCommitSha : null,
      pusher: git ? str(m.githubCommitAuthorLogin) : str(d.creator?.username),
      branchAlias: git ? https(m.branchAlias) : null,
      repo: git && str(m.githubOrg) && str(m.githubRepo) ? { org: m.githubOrg, repo: m.githubRepo } : null,
    };
  });
}

/** One list from several (two logins can see one team): first copy wins, newest first. */
export function mergeDeploys(lists) {
  const seen = new Map();
  for (const list of lists) for (const d of list) if (!seen.has(d.id)) seen.set(d.id, d);
  return [...seen.values()].sort((a, b) => b.created - a.created);
}

/** A failed CLI call as a kind and one user-facing line. */
export function vercelError(result) {
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.trim();
  const first = text.split("\n").map((l) => l.replace(/^Error:\s*/, "").trim()).find((l) => l !== "") ?? `vercel exited with ${result?.code}`;
  if (/credentials|not logged in|token is not valid|invalid token|login flow|\b401\b/i.test(text)) {
    return { kind: "login", line: "Vercel CLI isn't logged in: run vercel login" };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|offline/i.test(text)) {
    return { kind: "offline", line: "Can't reach Vercel (offline?)" };
  }
  if (/\b403\b|forbidden|not authorized/i.test(text)) {
    return { kind: "forbidden", line: "Vercel says this login can't see it (403)" };
  }
  return { kind: "other", line: first.length > 160 ? `${first.slice(0, 159)}…` : first };
}

export const inspectLogsArgs = (d) => ["inspect", d.url, "--logs", "--scope", d.team.slug, "--non-interactive"];

export function firstErrorLine(log) {
  const lines = String(log ?? "").split("\n");
  return lines.findIndex((l) => /\b(error|failed|ERR!)\b/i.test(l));
}

/** The last line that is an absolute path (a login shell may print a banner first), or null. */
export function pickPath(stdout) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => /^\/\S+$/.test(l));
  return lines.length ? lines[lines.length - 1] : null;
}

const MAX_LOG_LINE = 2000;

/** A build log as display lines: no CLI banner or agent hints, no colors, no timestamps. */
export function logLines(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => !/^<claude-code-hint\b/.test(l.trim()) && !/^Vercel CLI \d/.test(l.trim()))
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z\s{1,2}/, ""))
    .map((l) => (l.length > MAX_LOG_LINE ? `${l.slice(0, MAX_LOG_LINE)}…` : l))
    // One blank line at most between lines, none at either end.
    .filter((l, i, a) => l.trim() !== "" || (i > 0 && a[i - 1].trim() !== ""))
    .join("\n").trim().split("\n").filter((l, _i, a) => a.length > 1 || l !== "");
}

/**
 * The credentials file that must hold a token before `vercel` runs as this login, or null when
 * the token comes another way (Keychain, VERCEL_TOKEN). Checked before every call: without a
 * token the CLI starts a browser login flow, even with --non-interactive.
 */
export function authPathFor(login, env) {
  if (login.tokenKeychain) return null;
  if (login.name === "default" && !login.globalConfig && env.envToken) return null;
  return authFile(env.home, env.platform, login.globalConfig);
}
