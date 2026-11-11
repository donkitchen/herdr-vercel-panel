import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDeployments } from "../mods/vercel-panel/vercel.js";
import { parseConfig } from "../mods/vercel-panel/config.js";
import { decide, markOpened, emptyState } from "../mods/vercel-panel/seen.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const team = { id: "team_acme", slug: "acme", name: "Acme Co", login: "default" };
const deploys = () => parseDeployments(fx("deployments"), team);
const cfg = (o = {}) => parseConfig(JSON.stringify(o)).config;
const ME = new Set(["alice"]);
const set = (ds, id, patch) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d));
const started = (ds = deploys(), c = cfg(), me = ME) => decide(ds, emptyState(), c, me).state;

test("first run toasts nothing", () => {
  const r = decide(deploys(), emptyState(), cfg(), ME);
  assert.deepEqual(r.toasts, []);
  assert.deepEqual(r.finals, []);
  assert.equal(r.state.initialized, true);
  assert.ok(r.state.final.includes("dpl_API0eeee"));
  assert.ok(!r.state.final.includes("dpl_WEB1aaaa")); // its push is still building
});

test("in-flight at first run toasts later", () => {
  const s = started();
  const r = decide(set(deploys(), "dpl_ADM1aaaa", { state: "ready", readyAt: 1 }), s, cfg(), ME);
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, "feat/x: 3 of 3 ready");
  assert.equal(r.toasts[0].body, "feat/x · abc1234");
  assert.equal(r.toasts[0].level, "success");
  assert.equal(r.toasts[0].select, "p:prj_web"); // the project row: the push has left building now
});

test("never toasts twice", () => {
  const ds = set(deploys(), "dpl_ADM1aaaa", { state: "ready", readyAt: 1 });
  const r1 = decide(ds, started(), cfg(), ME);
  const r2 = decide(ds, r1.state, cfg(), ME);
  assert.deepEqual(r2.toasts, []);
  assert.deepEqual(r2.finals, []);
});

test("failed group names projects", () => {
  const r = decide(set(deploys(), "dpl_API1aaaa", { state: "error" }).map((d) => (d.id === "dpl_ADM1aaaa" ? { ...d, state: "ready" } : d)), started(), cfg(), ME);
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, "feat/x: 1 of 3 failed");
  assert.equal(r.toasts[0].body, "api");
  assert.equal(r.toasts[0].level, "error");
  assert.equal(r.toasts[0].select, "dpl_API1aaaa");
});

test("single deploy failure reads as that project", () => {
  const ds = deploys();
  const one = { ...ds.find((d) => d.id === "dpl_API0eeee"), id: "dpl_NEWERR", sha: "1112223334", created: 9e15 };
  const r = decide([...ds, one], started(), cfg(), ME);
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, "api deploy failed");
});

test("failures toast even when muted or from a bot", () => {
  const ds = deploys();
  const one = { ...ds.find((d) => d.id === "dpl_API0eeee"), id: "dpl_BOTERR", sha: "999", pusher: "github-actions[bot]", created: 9e15 };
  const r = decide([...ds, one], started(), cfg({ mute: [{ project: "api" }] }), ME);
  assert.equal(r.toasts.length, 1);
});

test("bot production is quiet", () => {
  const ds = deploys();
  const site = ds.find((d) => d.id === "dpl_SITEpppp");
  const newer = { ...site, id: "dpl_SITE2", sha: "77", created: 9e15 };
  assert.deepEqual(decide([...ds, newer], started(), cfg(), ME).toasts, []);
  const byListed = { ...newer, pusher: "release-bot" };
  assert.deepEqual(decide([...ds, byListed], started(), cfg({ bots: ["release-bot"] }), ME).toasts, []);
  const byHuman = { ...newer, pusher: "bob" };
  const r = decide([...ds, byHuman], started(), cfg(), ME);
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, "site is live");
});

test("muted production is quiet", () => {
  const ds = deploys();
  const newer = { ...ds.find((d) => d.id === "dpl_SITEpppp"), id: "dpl_SITE3", sha: "88", pusher: "bob", created: 9e15 };
  assert.deepEqual(decide([...ds, newer], started(), cfg({ mute: [{ project: "site" }] }), ME).toasts, []);
});

test("preview from someone else is quiet", () => {
  const ds = set(deploys(), "dpl_ADM1aaaa", { state: "ready" });
  const r = decide(ds, started(), cfg(), new Set(["carol"]));
  assert.deepEqual(r.toasts, []);
  assert.equal(r.finals.length, 1);
});

test("me matches case-insensitively", () => {
  const ds = set(deploys(), "dpl_ADM1aaaa", { state: "ready" });
  assert.equal(decide(ds, started(), cfg(), new Set(["ALICE"])).toasts.length, 1);
});

test("canceled ignored", () => {
  const ds = deploys();
  const a = { ...ds.find((d) => d.id === "dpl_WEB1aaaa"), id: "dpl_P1", sha: "pair", state: "ready", created: 9e15 };
  const b = { ...a, id: "dpl_P2", project: "api", state: "canceled" };
  const r = decide([...ds, a, b], started(), cfg(), ME);
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, "web preview ready");
});

test("group not final while one is building", () => {
  const r = decide(deploys(), started(), cfg(), ME);
  assert.deepEqual(r.finals, []);
});

test("finals includes quiet groups", () => {
  const ds = deploys();
  const newer = { ...ds.find((d) => d.id === "dpl_SITEpppp"), id: "dpl_SITE4", sha: "99", created: 9e15 };
  const r = decide([...ds, newer], started(), cfg(), ME);
  assert.equal(r.toasts.length, 0);
  assert.equal(r.finals.length, 1);
  assert.equal(r.finals[0].branch, "main");
  assert.deepEqual(r.finals[0].deploys.map((d) => d.id), ["dpl_SITE4"]);
});

test("final ids are pruned to the present plus the last 500", () => {
  const s = { initialized: true, final: Array.from({ length: 900 }, (_, i) => `old${i}`), opened: [] };
  const r = decide(deploys(), s, cfg(), ME);
  assert.ok(r.state.final.length <= 500 + deploys().length);
  assert.ok(r.state.final.includes("dpl_API0eeee"));
});

test("markOpened adds once", () => {
  const s = markOpened(markOpened(emptyState(), "x"), "x");
  assert.deepEqual(s.opened, ["x"]);
});

test("a team fetched for the first time later records quietly", () => {
  const s = started();
  const other = { id: "team_new", slug: "new", name: "New", login: "default" };
  const theirs = deploys().filter((d) => d.state !== "building").map((d) => ({ ...d, id: `${d.id}-n`, team: other }));
  const r = decide([...deploys(), ...theirs], s, cfg(), ME);
  assert.deepEqual(r.toasts, []);
  assert.deepEqual(r.finals, []);
  assert.ok(r.state.teams.includes("team_new"));
  const fresh = { ...theirs[0], id: "dpl_NEWTEAM", sha: "newsha", state: "error", created: 9e15 };
  assert.equal(decide([...deploys(), ...theirs, fresh], r.state, cfg(), ME).toasts.length, 1);
});

test("a redeploy of a failed commit toasts only itself", () => {
  const ds = deploys();
  const failed = ds.find((d) => d.id === "dpl_API0eeee");
  const s = started();
  const redo = { ...failed, id: "dpl_REDO", state: "ready", created: failed.created + 1000, readyAt: failed.created + 50000 };
  const r = decide([...ds, redo], s, cfg(), ME);
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].level, "success");
  assert.equal(r.toasts[0].title, "api preview ready");
});

test("excluded teams and projects never toast", () => {
  const ds = deploys();
  const one = { ...ds.find((d) => d.id === "dpl_API0eeee"), id: "dpl_EXCL", sha: "exsha", created: 9e15 };
  assert.deepEqual(decide([...ds, one], started(), cfg({ projects: { exclude: ["api"] } }), ME).toasts, []);
  assert.deepEqual(decide([...ds, one], started(), cfg({ teams: { exclude: ["acme"] } }), ME).toasts, []);
});
