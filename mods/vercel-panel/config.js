// Pure module: turns the text of vercel-panel.json into a normalized Config.
// Keys stay as in the file (snake_case). Unknown keys are ignored. Only the first problem is
// reported; the rest of the file still applies where it can.

const FILE = "vercel-panel.json";

export const DEFAULTS = Object.freeze({
  teams: { include: null, exclude: [] },
  projects: { exclude: [], recent_days: 7 },
  mute: [],
  bots: [],
  me: [],
  slow: { warn: 1.5, late: 3 },
  refresh_seconds: null,
  accounts: [],
  agent: { argv: ["claude"] },
  agents: { tell_on_finish: false },
});

const MIN_REFRESH = 15;
const TARGETS = ["production", "preview"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
// Herdr's runtime has no structuredClone.
const clone = (v) => JSON.parse(JSON.stringify(v));
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * @param {string|null} text file contents, or null when the file is missing
 * @returns {{config:any, problem:string|null}}
 */
export function parseConfig(text) {
  if (text === null || text === undefined) return { config: clone(DEFAULTS), problem: null };
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { config: clone(DEFAULTS), problem: `${FILE} is not valid JSON (${e.message}); using defaults` }; }
  if (!isObj(raw)) return { config: clone(DEFAULTS), problem: `${FILE} should be a JSON object; using defaults` };

  const c = clone(DEFAULTS);
  let problem = null;
  const bad = (msg) => { if (problem === null) problem = `${FILE}: ${msg}`; };
  const strList = (v, name, set) => {
    if (v === undefined) return;
    if (isStrList(v)) set(v.slice());
    else bad(`${name} must be a list of strings`);
  };

  if (raw.teams !== undefined) {
    if (!isObj(raw.teams)) bad("teams must be an object");
    else {
      strList(raw.teams.include, "teams.include", (v) => { c.teams.include = v; });
      strList(raw.teams.exclude, "teams.exclude", (v) => { c.teams.exclude = v; });
    }
  }
  if (raw.projects !== undefined) {
    if (!isObj(raw.projects)) bad("projects must be an object");
    else {
      strList(raw.projects.exclude, "projects.exclude", (v) => { c.projects.exclude = v; });
      const d = raw.projects.recent_days;
      if (d !== undefined) {
        if (typeof d === "number" && Number.isFinite(d) && d >= 0) c.projects.recent_days = d;
        else bad("projects.recent_days must be a number of days (0 shows every project)");
      }
    }
  }
  strList(raw.bots, "bots", (v) => { c.bots = v; });
  strList(raw.me, "me", (v) => { c.me = v; });

  if (raw.mute !== undefined) {
    if (!Array.isArray(raw.mute)) bad("mute must be a list");
    else raw.mute.forEach((m, i) => {
      const rule = {};
      if (isObj(m)) {
        if (typeof m.project === "string") rule.project = m.project;
        if (typeof m.author === "string") rule.author = m.author;
        if (TARGETS.includes(m.target)) rule.target = m.target;
      }
      if (Object.keys(rule).length === 0) bad(`mute[${i}] needs a project, author or target`);
      else c.mute.push(rule);
    });
  }

  if (raw.slow !== undefined) {
    if (!isObj(raw.slow)) bad("slow must be an object");
    else {
      const warn = raw.slow.warn === undefined ? c.slow.warn : raw.slow.warn;
      const late = raw.slow.late === undefined ? c.slow.late : raw.slow.late;
      if (!posNum(warn)) bad("slow.warn must be a positive number");
      else if (!posNum(late)) bad("slow.late must be a positive number");
      else if (late <= warn) bad("slow.late must be more than slow.warn");
      else c.slow = { warn, late };
    }
  }

  if (raw.refresh_seconds !== undefined) {
    if (posNum(raw.refresh_seconds)) {
      c.refresh_seconds = Math.max(MIN_REFRESH, raw.refresh_seconds);
      if (raw.refresh_seconds < MIN_REFRESH) bad(`refresh_seconds is at least ${MIN_REFRESH}; using ${MIN_REFRESH}`);
    } else bad("refresh_seconds must be a number of seconds");
  }

  if (raw.accounts !== undefined) {
    if (!Array.isArray(raw.accounts)) bad("accounts must be a list");
    else raw.accounts.forEach((a, i) => {
      const ok = isObj(a) && typeof a.name === "string" && a.name !== "" && a.name !== "default"
        && ((typeof a.global_config === "string" && a.global_config !== "") || (typeof a.token_keychain === "string" && a.token_keychain !== ""));
      if (!ok) { bad(`accounts[${i}] needs a name and a global_config or token_keychain`); return; }
      const acc = { name: a.name };
      if (typeof a.global_config === "string" && a.global_config !== "") acc.global_config = a.global_config;
      if (typeof a.token_keychain === "string" && a.token_keychain !== "") acc.token_keychain = a.token_keychain;
      c.accounts.push(acc);
    });
  }

  if (raw.agent !== undefined) {
    if (isObj(raw.agent) && isStrList(raw.agent.argv) && raw.agent.argv.length > 0) c.agent.argv = raw.agent.argv.slice();
    else bad("agent.argv must be a non-empty list of strings");
  }
  if (raw.agents !== undefined) {
    if (isObj(raw.agents) && typeof raw.agents.tell_on_finish === "boolean") c.agents.tell_on_finish = raw.agents.tell_on_finish;
    else bad("agents.tell_on_finish must be true or false");
  }

  return { config: c, problem };
}
