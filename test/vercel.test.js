import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  withLogin, tokenArgs, USER_PATH, TEAMS_PATH, deploymentsPath, projectsPath, apiArgs,
  parseUser, parseTeams, parseProjects, parseDeployments, mergeDeploys, vercelError,
  inspectLogsArgs, firstErrorLine, authFile, hasToken,
} from "../mods/vercel-panel/vercel.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const team = { id: "team_acme", slug: "acme", name: "Acme Co", login: "default" };
const deploys = () => parseDeployments(fx("deployments"), team);
const byId = (id) => deploys().find((d) => d.id === id);

test("withLogin adds -Q / --token and leaves default alone", () => {
  assert.deepEqual(withLogin({ name: "default" }, ["api", "/x"]), ["api", "/x"]);
  assert.deepEqual(withLogin({ name: "w", globalConfig: "/cfg" }, ["api", "/x"]), ["api", "/x", "-Q", "/cfg"]);
  assert.deepEqual(withLogin({ name: "t", tokenKeychain: "svc" }, ["api", "/x"], "tok"), ["api", "/x", "--token", "tok"]);
  assert.deepEqual(tokenArgs("svc"), ["find-generic-password", "-s", "svc", "-w"]);
});

test("paths always carry teamId", () => {
  assert.equal(deploymentsPath("team_a"), "/v6/deployments?teamId=team_a&limit=50");
  assert.equal(projectsPath("team_a"), "/v9/projects?teamId=team_a&limit=100");
  assert.equal(USER_PATH, "/v2/user");
  assert.equal(TEAMS_PATH, "/v2/teams?limit=100");
  assert.deepEqual(apiArgs("/v2/user"), ["api", "/v2/user", "--non-interactive"]);
});

test("parseUser and parseTeams", () => {
  assert.deepEqual(parseUser(fx("user")), { username: "alice", githubLogin: "alice-gh" });
  assert.deepEqual(parseUser({}), { username: null, githubLogin: null });
  assert.deepEqual(parseTeams(fx("teams"), "default"), [
    { id: "team_acme", slug: "acme", name: "Acme Co", login: "default" },
    { id: "team_side", slug: "side", name: "Side Project", login: "default" },
  ]);
});

test("parses deployments", () => {
  const d = byId("dpl_ADM1aaaa");
  assert.equal(d.state, "building");
  assert.equal(d.target, "preview");
  assert.equal(d.project, "admin");
  assert.equal(d.projectId, "prj_admin");
  assert.equal(d.url, "https://admin-adm1aa-acme.vercel.app");
  assert.equal(d.branch, "feat/x");
  assert.equal(d.sha, "abc1234def");
  assert.equal(d.pusher, "alice");
  assert.equal(d.branchAlias, "https://admin-git-feat-x-acme.vercel.app");
  assert.deepEqual(d.repo, { org: "acme", repo: "monorepo" });
  assert.equal(d.readyAt, null);
  assert.equal(d.team, team);
  assert.equal(byId("dpl_SITEpppp").target, "production");
  assert.equal(byId("dpl_SITEpppp").pusher, "github-actions[bot]");
  assert.equal(byId("dpl_WEB0cccc").state, "canceled");
  assert.equal(byId("dpl_API0eeee").state, "error");
  assert.equal(byId("dpl_WEB1aaaa").state, "ready");
});

test("queued and initializing map to queued", () => {
  const raw = { deployments: [{ ...fx("deployments").deployments[0], readyState: "INITIALIZING", state: "INITIALIZING" }] };
  assert.equal(parseDeployments(raw, team)[0].state, "queued");
});

test("parses a CLI deploy", () => {
  const d = byId("dpl_CLI1zzzz");
  assert.equal(d.branch, null);
  assert.equal(d.sha, null);
  assert.equal(d.pusher, "alice"); // creator
  assert.equal(d.branchAlias, null);
  assert.equal(d.repo, null);
  assert.equal(d.startedAt, d.created); // no buildingAt
});

test("parses projects", () => {
  const ps = parseProjects(fx("projects"), "team_acme");
  const web = ps.find((p) => p.id === "prj_web");
  assert.equal(web.prodUrl, "https://web.acme.example"); // custom domain first
  assert.deepEqual(web.repo, { org: "acme", repo: "monorepo" });
  assert.deepEqual(web.prod, { url: "https://web-prod1-acme.vercel.app", state: "ready", created: 1794352800000 });
  assert.equal(web.teamId, "team_acme");
  assert.equal(ps.find((p) => p.id === "prj_api").prodUrl, "https://api.vercel.app"); // no custom: first alias
  const tool = ps.find((p) => p.id === "prj_tool");
  assert.equal(tool.repo, null);
  assert.equal(tool.prod, null);
  assert.equal(tool.prodUrl, null);
});

test("mergeDeploys dedupes by id, newest first", () => {
  const a = deploys();
  const merged = mergeDeploys([a, a.slice(0, 2)]);
  assert.equal(merged.length, a.length);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].created >= merged[i].created);
});

test("vercelError classifies", () => {
  assert.equal(vercelError({ code: 1, stdout: "", stderr: "Error: Not authorized (403)" }).kind, "forbidden");
  assert.equal(vercelError({ code: 1, stdout: "", stderr: "Error: getaddrinfo ENOTFOUND api.vercel.com" }).kind, "offline");
  assert.equal(vercelError({ code: 1, stdout: "", stderr: "ETIMEDOUT" }).kind, "offline");
  assert.equal(vercelError({ code: 1, stdout: "", stderr: "No existing credentials found." }).kind, "login");
  assert.equal(vercelError({ code: 1, stdout: "", stderr: "Error: The specified token is not valid" }).kind, "login");
  const o = vercelError({ code: 2, stdout: "", stderr: "something odd" });
  assert.equal(o.kind, "other");
  assert.match(o.line, /something odd/);
  assert.match(vercelError({ code: 1, stdout: "", stderr: "No existing credentials found." }).line, /vercel login/);
});

test("auth file and token check", () => {
  assert.equal(authFile("/Users/a", "darwin"), "/Users/a/Library/Application Support/com.vercel.cli/auth.json");
  assert.equal(authFile("/home/a", "linux"), "/home/a/.local/share/com.vercel.cli/auth.json");
  assert.equal(authFile("/Users/a", "darwin", "/cfg"), "/cfg/auth.json");
  assert.equal(hasToken('{"token":"abc"}'), true);
  assert.equal(hasToken('{"token":""}'), false);
  assert.equal(hasToken("{}"), false);
  assert.equal(hasToken(null), false);
  assert.equal(hasToken("nope"), false);
});

test("inspectLogsArgs and firstErrorLine", () => {
  assert.deepEqual(inspectLogsArgs(byId("dpl_API0eeee")),
    ["inspect", "https://api-api0ee-acme.vercel.app", "--logs", "--scope", "acme", "--non-interactive"]);
  assert.equal(firstErrorLine("a\nb\nType error: x\nfailed"), 2);
  assert.equal(firstErrorLine("Build Failed\n"), 0);
  assert.equal(firstErrorLine("all good\ndone"), -1);
});

test("pickPath takes the last absolute path a shell printed", async () => {
  const { pickPath } = await import("../mods/vercel-panel/vercel.js");
  assert.equal(pickPath("\u001b[0mwelcome\n/Users/a/Library/pnpm/vercel\n"), "/Users/a/Library/pnpm/vercel");
  assert.equal(pickPath("vercel not found\n"), null);
  assert.equal(pickPath(""), null);
});

test("logLines strips the banner, hints, colors and timestamps", async () => {
  const { logLines } = await import("../mods/vercel-panel/vercel.js");
  const raw = '<claude-code-hint v="1" type="plugin" value="x" />\nVercel CLI 65.12.1\n'
    + "2026-11-10T17:37:17.001Z  Running build\n2026-11-10T17:37:31.955Z  \u001b[31m> Build error occurred\u001b[0m\nplain line\n\n";
  assert.deepEqual(logLines(raw), ["Running build", "> Build error occurred", "plain line"]);
  assert.deepEqual(logLines(""), []);
  assert.equal(logLines("x".repeat(3000))[0].length, 2001);
});

test("authPathFor: which credentials file a call needs, if any", async () => {
  const { authPathFor } = await import("../mods/vercel-panel/vercel.js");
  const env = { home: "/Users/a", platform: "darwin", envToken: false };
  assert.equal(authPathFor({ name: "default" }, env), "/Users/a/Library/Application Support/com.vercel.cli/auth.json");
  assert.equal(authPathFor({ name: "w", globalConfig: "/cfg" }, env), "/cfg/auth.json");
  assert.equal(authPathFor({ name: "t", tokenKeychain: "svc" }, env), null); // token passed on the call
  assert.equal(authPathFor({ name: "default" }, { ...env, envToken: true }), null); // VERCEL_TOKEN set
});
