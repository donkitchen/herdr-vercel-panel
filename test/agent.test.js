import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDeployments } from "../mods/vercel-panel/vercel.js";
import { askMessage, findAgent, spaceForRepo, sendDecision } from "../mods/vercel-panel/agent.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const team = { id: "team_acme", slug: "acme", name: "Acme Co", login: "default" };
const byId = (id) => parseDeployments(fx("deployments"), team).find((d) => d.id === id);
const AT = new Date(2026, 10, 7, 12, 58, 0);
const pane = (o) => ({ pane: "p", terminal: "t1", cwd: "/code/monorepo", branch: "fix/y", status: "idle", ...o });

test("message with git metadata", () => {
  assert.equal(askMessage(byId("dpl_API0eeee"), AT),
    "The Vercel preview deploy of api (Acme Co team, branch fix/y, commit fff9999) failed at 12:58. "
    + "Deploy: https://api-api0ee-acme.vercel.app. "
    + "Build log: `vercel inspect https://api-api0ee-acme.vercel.app --logs --scope acme`. Find out why it failed.");
});

test("message without git metadata", () => {
  const d = { ...byId("dpl_CLI1zzzz"), state: "error", target: "production" };
  assert.equal(askMessage(d, new Date(2026, 0, 1, 9, 5)),
    "The Vercel production deploy of tool (Acme Co team) failed at 09:05. "
    + "Deploy: https://tool-cli1zz-acme.vercel.app. "
    + "Build log: `vercel inspect https://tool-cli1zz-acme.vercel.app --logs --scope acme`. Find out why it failed.");
});

test("findAgent by branch", () => {
  const d = byId("dpl_API0eeee");
  assert.equal(findAgent(d, [pane({ branch: "main" }), pane({ terminal: "t2" })]).terminal, "t2");
  assert.equal(findAgent(d, [pane({ branch: "main" })]), null);
});

test("findAgent skips non-agents and mod panes", () => {
  const d = byId("dpl_API0eeee");
  assert.equal(findAgent(d, [pane({ status: null }), pane({ terminal: null, mod: "x" })]), null);
});

test("findAgent prefers matching cwd", () => {
  const d = byId("dpl_API0eeee");
  const got = findAgent(d, [pane({ terminal: "t1", cwd: "/code/other" }), pane({ terminal: "t2", cwd: "/code/monorepo" })]);
  assert.equal(got.terminal, "t2");
});

test("findAgent null without branch", () => {
  assert.equal(findAgent(byId("dpl_CLI1zzzz"), [pane({ branch: null })]), null);
});

test("spaceForRepo case-insensitive", () => {
  const spaces = [{ id: "s1", folder: "/code/other" }, { id: "s2", folder: "/code/MonoRepo/" }];
  assert.equal(spaceForRepo({ org: "acme", repo: "monorepo" }, spaces).id, "s2");
  assert.equal(spaceForRepo({ org: "acme", repo: "nope" }, spaces), null);
  assert.equal(spaceForRepo(null, spaces), null);
});

test("sendDecision", () => {
  const e = { terminal: "t1" };
  assert.equal(sendDecision(e, [pane({ status: "idle" })]), "send");
  assert.equal(sendDecision(e, [pane({ status: "done" })]), "send");
  assert.equal(sendDecision(e, [pane({ status: "working" })]), "wait");
  assert.equal(sendDecision(e, [pane({ status: "blocked" })]), "wait");
});

test("sendDecision drops when terminal gone", () => {
  assert.equal(sendDecision({ terminal: "t1" }, [pane({ terminal: "t9" })]), "drop");
  assert.equal(sendDecision({ terminal: "t1" }, [pane({ status: null })]), "drop"); // agent exited, shell left
});

test("findAgent never picks an agent in another repo", () => {
  const d = byId("dpl_API0eeee"); // repo monorepo
  assert.equal(findAgent(d, [pane({ cwd: "/code/other-app" })]), null);
  const noRepo = { ...d, repo: null };
  assert.equal(findAgent(noRepo, [pane({ cwd: "/code/other-app" })]).terminal, "t1");
});
