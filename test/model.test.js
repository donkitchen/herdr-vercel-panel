import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDeployments, parseProjects } from "../mods/vercel-panel/vercel.js";
import { parseConfig } from "../mods/vercel-panel/config.js";
import {
  groupKey, isBot, isMuted, typicalMs, slowLevel, buildView, siteUrl, formatElapsed,
} from "../mods/vercel-panel/model.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const team = { id: "team_acme", slug: "acme", name: "Acme Co", login: "default" };
const deploys = () => parseDeployments(fx("deployments"), team);
const projects = () => parseProjects(fx("projects"), "team_acme");
const cfg = (o = {}) => parseConfig(JSON.stringify(o)).config;
const NOW = 1794360000000 + 120000;
const view = (o = {}, opened = new Set(), ds = deploys()) => buildView(ds, projects(), cfg(o), opened, NOW);

test("push groups by branch+sha", () => {
  const v = view();
  assert.equal(v.building.length, 1);
  const g = v.building[0];
  assert.equal(g.label, "feat/x");
  assert.equal(g.ready, 2);
  assert.equal(g.total, 3);
  assert.equal(g.elapsedMs, NOW - (1794360000000 + 1000));
  assert.equal(g.team, team);
});

test("CLI deploys group alone", () => {
  const ds = deploys();
  const cli = ds.find((d) => d.id === "dpl_CLI1zzzz");
  assert.equal(groupKey(cli), "dpl_CLI1zzzz");
  const building = { ...cli, id: "dpl_CLI2", state: "building", readyAt: null };
  const v = view({}, new Set(), [...ds, building]);
  const g = v.building.find((x) => x.key === "dpl_CLI2");
  assert.equal(g.label, "tool");
  assert.equal(g.total, 1);
});

test("canceled never appears", () => {
  const v = view();
  const all = [...v.building.flatMap((g) => g.deploys), ...v.failed, ...v.teams.flatMap((t) => t.rows.map((r) => r.preview)).filter(Boolean)];
  assert.ok(!all.some((d) => d.state === "canceled"));
});

test("group leaves building when nothing is in flight", () => {
  const ds = deploys().map((d) => (d.id === "dpl_ADM1aaaa" ? { ...d, state: "ready", readyAt: NOW } : d));
  assert.equal(view({}, new Set(), ds).building.length, 0);
});

test("muted deploy hidden from building but updates its row", () => {
  const v = view({ mute: [{ project: "admin" }] });
  assert.equal(v.building.length, 0); // admin was the only one in flight
  assert.equal(v.count.inFlight, 0);
  const adminRow = v.teams[0].rows.find((r) => r.project.id === "prj_admin");
  assert.equal(adminRow, undefined); // admin has no project record in the fixture
  const ds = deploys();
  const v2 = buildView(ds, [...projects(), { id: "prj_admin", name: "admin", teamId: "team_acme", repo: null, prodUrl: null, prod: null }], cfg({ mute: [{ project: "admin" }] }), new Set(), NOW);
  assert.equal(v2.teams[0].rows.find((r) => r.project.id === "prj_admin").preview.id, "dpl_ADM1aaaa");
});

test("failed shows until opened", () => {
  assert.deepEqual(view().failed.map((d) => d.id), ["dpl_API0eeee"]);
  assert.deepEqual(view({}, new Set(["dpl_API0eeee"])).failed, []);
});

test("failed clears after a later ready deploy of the same project and branch", () => {
  const ds = deploys();
  const fixed = { ...ds.find((d) => d.id === "dpl_API0eeee"), id: "dpl_API9", state: "ready", created: NOW - 1000, readyAt: NOW };
  assert.deepEqual(view({}, new Set(), [...ds, fixed]).failed, []);
});

test("failures ignore mute", () => {
  assert.equal(view({ mute: [{ project: "api" }] }).failed.length, 1);
  const d = deploys().find((x) => x.id === "dpl_API0eeee");
  assert.equal(isMuted(d, cfg({ mute: [{ project: "api" }] })), false);
});

test("isMuted needs every field of a rule", () => {
  const site = deploys().find((d) => d.id === "dpl_SITEpppp");
  assert.equal(isMuted(site, cfg({ mute: [{ project: "site", author: "github-actions[bot]" }] })), true);
  assert.equal(isMuted(site, cfg({ mute: [{ project: "site", author: "alice" }] })), false);
  assert.equal(isMuted(site, cfg({ mute: [{ target: "preview" }] })), false);
});

test("isBot", () => {
  assert.equal(isBot("github-actions[bot]", cfg()), true);
  assert.equal(isBot("Release-Bot", cfg({ bots: ["release-bot"] })), true);
  assert.equal(isBot("alice", cfg()), false);
  assert.equal(isBot(null, cfg()), false);
});

test("typicalMs median, null under 3", () => {
  const mk = (i, ms) => ({ id: `d${i}`, projectId: "p", state: "ready", startedAt: 0, readyAt: ms, created: i });
  assert.equal(typicalMs([mk(1, 10), mk(2, 20)], "p"), null);
  assert.equal(typicalMs([mk(1, 10), mk(2, 30), mk(3, 20)], "p"), 20);
  const many = Array.from({ length: 12 }, (_, i) => mk(i, i < 2 ? 1000 : 50)); // the two oldest are outliers
  assert.equal(typicalMs(many, "p"), 50);
});

test("slowLevel thresholds", () => {
  const s = { warn: 1.5, late: 3 };
  assert.equal(slowLevel(89000, 60000, s), null);
  assert.equal(slowLevel(90000, 60000, s), "warn");
  assert.equal(slowLevel(180000, 60000, s), "late");
  assert.equal(slowLevel(999999, null, s), null);
});

test("teams and projects excluded by config", () => {
  assert.equal(view({ teams: { exclude: ["acme"] } }).teams.length, 0);
  assert.equal(view({ teams: { exclude: ["acme"] } }).building.length, 0);
  assert.equal(view({ teams: { include: ["other"] } }).teams.length, 0);
  const v = view({ projects: { exclude: ["acme/web"] } });
  assert.ok(!v.teams[0].rows.some((r) => r.project.name === "web"));
  assert.ok(!v.building[0].deploys.some((d) => d.project === "web"));
  assert.ok(!view({ projects: { exclude: ["api"] } }).teams[0].rows.some((r) => r.project.name === "api"));
});

test("count is in-flight deploys and unopened failures", () => {
  assert.deepEqual(view().count, { inFlight: 1, failed: 1 });
  assert.deepEqual(view({}, new Set(["dpl_API0eeee"])).count, { inFlight: 1, failed: 0 });
});

test("project rows pair prod and newest preview", () => {
  const rows = view().teams[0].rows;
  const web = rows.find((r) => r.project.id === "prj_web");
  assert.equal(web.prod.state, "ready");
  assert.equal(web.preview.id, "dpl_WEB1aaaa"); // canceled main build skipped
  const api = rows.find((r) => r.project.id === "prj_api");
  assert.equal(api.preview.id, "dpl_API1aaaa");
});

test("siteUrl prefers branchAlias", () => {
  const ds = deploys();
  const web = view().teams[0].rows.find((r) => r.project.id === "prj_web");
  assert.equal(siteUrl(web, "prod"), "https://web.acme.example");
  assert.equal(siteUrl(web, "preview"), "https://web-git-feat-x-acme.vercel.app");
  assert.equal(siteUrl(ds.find((d) => d.id === "dpl_ADM1aaaa")), "https://admin-adm1aa-acme.vercel.app");
  const toolRow = { project: { prodUrl: null }, prod: null, preview: ds.find((d) => d.id === "dpl_CLI1zzzz") };
  assert.equal(siteUrl(toolRow, "preview"), "https://tool-cli1zz-acme.vercel.app");
  assert.equal(siteUrl(toolRow, "prod"), null);
});

test("formatElapsed", () => {
  assert.equal(formatElapsed(42000), "42s");
  assert.equal(formatElapsed(192000), "3m 12s");
  assert.equal(formatElapsed(3840000), "1h 4m");
  assert.equal(formatElapsed(-5), "0s");
});

test("formatAgo", async () => {
  const { formatAgo } = await import("../mods/vercel-panel/model.js");
  assert.equal(formatAgo(30000), "now");
  assert.equal(formatAgo(16 * 60000), "16m");
  assert.equal(formatAgo(5 * 3600000), "5h");
  assert.equal(formatAgo(47 * 3600000), "47h");
  assert.equal(formatAgo(126 * 3600000), "5d");
});

test("old projects are hidden and counted unless showAll", () => {
  // NOW is 2 min after the fixture's newest deploys; web/api prod were 2h before that.
  const old = { id: "prj_old", name: "old", teamId: "team_acme", repo: null, prodUrl: null, prod: { url: "https://o", state: "ready", created: NOW - 10 * 86400000 } };
  const v = buildView(deploys(), [...projects(), old], cfg(), new Set(), NOW);
  assert.ok(!v.teams[0].rows.some((r) => r.project.id === "prj_old"));
  assert.equal(v.hiddenOld, 1);
  const all = buildView(deploys(), [...projects(), old], cfg(), new Set(), NOW, [], { recentDays: 0 });
  assert.ok(all.teams[0].rows.some((r) => r.project.id === "prj_old"));
  assert.equal(all.hiddenOld, 0);
  const zero = buildView(deploys(), [...projects(), old], cfg({ projects: { recent_days: 0 } }), new Set(), NOW);
  assert.ok(zero.teams[0].rows.some((r) => r.project.id === "prj_old"));
});

test("a redeploy replaces the older deploy of its project in its push", () => {
  const ds = deploys();
  const failed = ds.find((d) => d.id === "dpl_API0eeee");
  const redo = { ...failed, id: "dpl_REDO", state: "building", readyAt: null, created: failed.created + 1000, startedAt: failed.created + 1000 };
  const v = view({}, new Set(), [...ds, redo]);
  const g = v.building.find((x) => x.deploys.some((d) => d.id === "dpl_REDO"));
  assert.equal(g.total, 1);
  assert.equal(g.ready, 0);
});

test("prod cell follows a newer production deploy than the project record", () => {
  const ds = deploys();
  const web = ds.find((d) => d.id === "dpl_WEB1aaaa");
  const live = { ...web, id: "dpl_WEBPROD", target: "production", state: "ready", created: NOW - 1000, readyAt: NOW - 500, url: "https://web-new.vercel.app" };
  const row = view({}, new Set(), [...ds, live]).teams[0].rows.find((r) => r.project.id === "prj_web");
  assert.equal(row.prod.created, NOW - 1000);
  assert.equal(row.prod.state, "ready");
});

const other = { id: "team_side", slug: "side", name: "Side", login: "default" };
const twoTeams = () => {
  const mine = deploys();
  const theirs = mine.map((d) => ({ ...d, id: `${d.id}-s`, team: other, projectId: `${d.projectId}-s` }));
  const ps = [...projects(), ...projects().map((p) => ({ ...p, id: `${p.id}-s`, teamId: "team_side" }))];
  return { ds: [...mine, ...theirs], ps };
};

test("recentDays option overrides the config window", () => {
  const old = { id: "prj_old", name: "old", teamId: "team_acme", repo: null, prodUrl: null, prod: { url: "https://o", state: "ready", created: NOW - 2 * 86400000 } };
  const day = buildView(deploys(), [...projects(), old], cfg(), new Set(), NOW, [], { recentDays: 1 });
  assert.ok(!day.teams[0].rows.some((r) => r.project.id === "prj_old"));
  assert.equal(day.hiddenOld, 1);
  const month = buildView(deploys(), [...projects(), old], cfg(), new Set(), NOW, [], { recentDays: 30 });
  assert.ok(month.teams[0].rows.some((r) => r.project.id === "prj_old"));
});

test("team option shows one team; the count still covers every team", () => {
  const { ds, ps } = twoTeams();
  const all = buildView(ds, ps, cfg(), new Set(), NOW);
  const side = buildView(ds, ps, cfg(), new Set(), NOW, [], { team: "team_side" });
  assert.deepEqual(side.teams.map((t) => t.team.id), ["team_side"]);
  assert.ok(side.building.every((g) => g.team.id === "team_side"));
  assert.ok(side.failed.every((d) => d.team.id === "team_side"));
  assert.deepEqual(side.count, all.count);
  assert.equal(all.count.failed, 2);
});

test("target option keeps one target", () => {
  const prod = view({}, new Set(), deploys());
  const p = buildView(deploys(), projects(), cfg(), new Set(), NOW, [], { target: "production" });
  assert.equal(p.building.length, 0); // the feat/x push is a preview
  assert.equal(p.failed.length, 0);
  assert.ok(p.teams[0].rows.every((r) => r.prod));
  const v = buildView(deploys(), projects(), cfg(), new Set(), NOW, [], { target: "preview" });
  assert.equal(v.building.length, 1);
  assert.ok(v.teams[0].rows.every((r) => r.preview));
  assert.deepEqual(p.count, prod.count);
});

test("mine option keeps deploys you pushed", () => {
  const ds = deploys().map((d) => (d.id === "dpl_API0eeee" ? { ...d, pusher: "bob" } : d));
  const v = buildView(ds, projects(), cfg(), new Set(), NOW, [], { mine: new Set(["alice"]) });
  assert.equal(v.failed.length, 0); // bob's failure hidden
  assert.equal(v.building.length, 1); // alice's push
  assert.ok(v.teams[0].rows.some((r) => r.project.id === "prj_web"));
  const none = buildView(ds, projects(), cfg(), new Set(), NOW, [], { mine: new Set(["carol"]) });
  assert.equal(none.building.length, 0);
  assert.equal(none.teams.length, 0);
});

test("filterCycles", async () => {
  const { nextOf } = await import("../mods/vercel-panel/model.js");
  assert.equal(nextOf([1, 7, 30, 0], 7), 30);
  assert.equal(nextOf([1, 7, 30, 0], 0), 1);
  assert.equal(nextOf([null, "a", "b"], "zzz"), null);
});
