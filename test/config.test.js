import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../mods/vercel-panel/config.js";

test("null text gives defaults", () => {
  const { config: c, problem } = parseConfig(null);
  assert.equal(problem, null);
  assert.equal(c.teams.include, null);
  assert.deepEqual(c.teams.exclude, []);
  assert.deepEqual(c.projects.exclude, []);
  assert.deepEqual(c.mute, []);
  assert.deepEqual(c.bots, []);
  assert.deepEqual(c.me, []);
  assert.deepEqual(c.slow, { warn: 1.5, late: 3 });
  assert.equal(c.refresh_seconds, null);
  assert.deepEqual(c.accounts, []);
  assert.deepEqual(c.agent.argv, ["claude"]);
  assert.equal(c.agents.tell_on_finish, false);
});

test("invalid JSON gives defaults and one line", () => {
  const { config: c, problem } = parseConfig("{nope");
  assert.match(problem, /not valid JSON/);
  assert.deepEqual(c.slow, { warn: 1.5, late: 3 });
});

test("bad value keeps that default", () => {
  const { config: c, problem } = parseConfig(JSON.stringify({ slow: { warn: "x" }, bots: ["a"] }));
  assert.equal(c.slow.warn, 1.5);
  assert.deepEqual(c.bots, ["a"]);
  assert.match(problem, /slow\.warn/);
});

test("refresh below 15 clamps and says so", () => {
  const { config: c, problem } = parseConfig(JSON.stringify({ refresh_seconds: 5 }));
  assert.equal(c.refresh_seconds, 15);
  assert.match(problem, /15/);
});

test("slow.late must exceed slow.warn", () => {
  const { config: c, problem } = parseConfig(JSON.stringify({ slow: { warn: 3, late: 2 } }));
  assert.deepEqual(c.slow, { warn: 1.5, late: 3 });
  assert.match(problem, /slow/);
});

test("mute rule needs one field", () => {
  const { config: c, problem } = parseConfig(JSON.stringify({ mute: [{}] }));
  assert.deepEqual(c.mute, []);
  assert.match(problem, /mute\[0\]/);
});

test("mute rules, teams, accounts and agent parse", () => {
  const { config: c, problem } = parseConfig(JSON.stringify({
    mute: [{ project: "site", author: "ci[bot]", target: "production" }],
    teams: { include: ["a"], exclude: ["b"] },
    projects: { exclude: ["a/web"] },
    me: ["alice"],
    accounts: [{ name: "work", global_config: "/x" }, { name: "t", token_keychain: "svc" }],
    agent: { argv: ["codex", "--yolo"] },
    agents: { tell_on_finish: true },
  }));
  assert.equal(problem, null);
  assert.deepEqual(c.mute, [{ project: "site", author: "ci[bot]", target: "production" }]);
  assert.deepEqual(c.teams, { include: ["a"], exclude: ["b"] });
  assert.deepEqual(c.projects.exclude, ["a/web"]);
  assert.deepEqual(c.me, ["alice"]);
  assert.deepEqual(c.accounts, [{ name: "work", global_config: "/x" }, { name: "t", token_keychain: "svc" }]);
  assert.deepEqual(c.agent.argv, ["codex", "--yolo"]);
  assert.equal(c.agents.tell_on_finish, true);
});

test("account needs a name and one way in", () => {
  const { config: c, problem } = parseConfig(JSON.stringify({ accounts: [{ name: "x" }, { global_config: "/y" }] }));
  assert.deepEqual(c.accounts, []);
  assert.match(problem, /accounts\[0\]/);
});

test("unknown keys ignored", () => {
  const { problem } = parseConfig(JSON.stringify({ whatever: 1 }));
  assert.equal(problem, null);
});

test("projects.recent_days defaults to 7 and accepts 0 for all", () => {
  assert.equal(parseConfig(null).config.projects.recent_days, 7);
  assert.equal(parseConfig(JSON.stringify({ projects: { recent_days: 30 } })).config.projects.recent_days, 30);
  assert.equal(parseConfig(JSON.stringify({ projects: { recent_days: 0 } })).config.projects.recent_days, 0);
  const bad = parseConfig(JSON.stringify({ projects: { recent_days: -1 } }));
  assert.equal(bad.config.projects.recent_days, 7);
  assert.match(bad.problem, /recent_days/);
});
