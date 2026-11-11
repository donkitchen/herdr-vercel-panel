// Pure module: the "ask an agent" message, and finding the agent or space it goes to.

const lc = (s) => String(s ?? "").toLowerCase();
const two = (n) => String(n).padStart(2, "0");
const lastSegment = (p) => lc(String(p ?? "").replace(/\/+$/, "").split("/").pop());

/** The message `a` sends about a failed deploy. Exact copy from the design. */
export function askMessage(d, at) {
  const where = d.branch && d.sha
    ? `${d.team.name} team, branch ${d.branch}, commit ${d.sha.slice(0, 7)}`
    : `${d.team.name} team`;
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  return `The Vercel ${d.target} deploy of ${d.project} (${where}) failed at ${time}. `
    + `Deploy: ${d.url}. `
    + `Build log: \`vercel inspect ${d.url} --logs --scope ${d.team.slug}\`. Find out why it failed.`;
}

/** The agent pane on the deploy's branch; one in the matching repo folder wins. */
export function findAgent(d, panes) {
  if (!d.branch) return null;
  const on = panes.filter((p) => p.terminal && p.status && p.branch === d.branch);
  if (on.length === 0) return null;
  // Many agents sit on `main`: with a known repo, only one in that repo's folder counts.
  if (!d.repo) return on[0];
  const repo = lc(d.repo.repo);
  return on.find((p) => lastSegment(p.cwd) === repo) ?? null;
}

/** The space whose folder is named like the repo, as pr-panel's `g` finds one. */
export function spaceForRepo(repo, spaces) {
  if (!repo) return null;
  const name = lc(repo.repo);
  return spaces.find((s) => lastSegment(s.folder) === name) ?? null;
}

/** What to do with a queued message now: send it, keep waiting, or drop it (agent gone). */
export function sendDecision(entry, panes) {
  const p = panes.find((x) => x.terminal === entry.terminal);
  if (!p || !p.status) return "drop";
  return p.status === "idle" || p.status === "done" ? "send" : "wait";
}
