#!/usr/bin/env node
// onboard.mjs — steps 5, 6, 7 of the t3-fleet-onboard runbook: create the
// default project, mint/rotate the agent bearer, and run the four
// verification checks. Steps 1-4 (Node install, service install, tailscale
// serve drop-in, provider-CLI presence) and step 8 (optional T3 Connect
// link) are plain SSH/systemctl commands with no secrets involved and are
// run directly by the skill via Bash, per SKILL.md — they are not bundled
// here.
//
// Design doc: /home/blaise/.claude/plans/t3-connect-fleet-design.md
// ("Layer 1 — onboarding a new box", steps 5-7).
//
// This script is what actually shells out to `ssh` to mint the bearer, and
// it is the ONLY thing that ever sees the raw token: it reads it from the
// remote `t3 auth session issue --json` output and writes it straight into
// the mode-0600 config file. It never prints the token to stdout/stderr, so
// the calling agent's transcript never contains it.
//
// Usage:
//   node onboard.mjs <host> [--workspace-root PATH] [--title TITLE]
//                     [--label LABEL] [--t3-version VERSION] [--skip-verify]
//
// Exit code is non-zero if any of the four verification checks fail (or
// times out) — an install that can't prove itself working is a FAILED run,
// not a partial one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// --- fleet ownership gate --------------------------------------------------
// Only the user's own boxes are eligible. Being SSH-reachable is not
// sufficient — nuc/teddy-computer/lovelandnuc are shared machines and
// must never have anything installed on them. This is enforced here too
// (not just in SKILL.md prose) so a direct script invocation can't skip it.
// `war` was shared until 2026-08-12, when the user reclassified it as their
// own machine.
const ELIGIBLE = new Set(["archlinux", "littlearch", "bigarch", "war"]);
const SHARED_NEVER_INSTALL = new Set(["nuc", "teddy-computer", "lovelandnuc"]);

// Version-pinned in one place. Bump this (and re-run against archlinux
// first, per the doc's sequencing warning) to move the fleet.
const DEFAULT_T3_VERSION = "0.0.33";

const CONFIG_PATH =
  process.env.FLEET_CONFIG || path.join(os.homedir(), ".config", "fleet", "hosts.json");

const VERIFY_TIMEOUT_S = 120;
const POLL_INTERVAL_MS = 1500;

function die(msg, code = 1) {
  process.stderr.write(`onboard: ${msg}\n`);
  process.exit(code);
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function parseArgs(argv) {
  const [host, ...rest] = argv;
  if (!host) {
    die(
      "usage: onboard.mjs <host> [--workspace-root PATH] [--title TITLE] " +
        "[--label LABEL] [--t3-version VERSION] [--skip-verify]",
      2
    );
  }
  const opts = {
    host,
    workspaceRoot: "/home/blaise",
    title: `${host} Main`,
    label: "archlinux-agent",
    t3Version: DEFAULT_T3_VERSION,
    skipVerify: false,
  };
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--workspace-root":
        opts.workspaceRoot = rest[++i];
        break;
      case "--title":
        opts.title = rest[++i];
        break;
      case "--label":
        opts.label = rest[++i];
        break;
      case "--t3-version":
        opts.t3Version = rest[++i];
        break;
      case "--skip-verify":
        opts.skipVerify = true;
        break;
      default:
        die(`unknown flag: ${rest[i]}`, 2);
    }
  }
  return opts;
}

function gateOwnership(host) {
  if (SHARED_NEVER_INSTALL.has(host)) {
    die(
      `"${host}" is a SHARED machine (nuc/teddy-computer/lovelandnuc) and must never be ` +
        `installed on. Refusing. See "Machine ownership" in the design doc.`
    );
  }
  if (!ELIGIBLE.has(host)) {
    die(
      `"${host}" is not in the eligible fleet (${[...ELIGIBLE].join(", ")}). Refusing to onboard ` +
        `an unrecognized box — add it to ELIGIBLE in this script only after confirming ownership.`
    );
  }
}

// --- ssh -------------------------------------------------------------------
// Always BatchMode=yes, always as blaise. If key auth fails, we stop and
// report it — we never fall through to a password prompt (BatchMode=yes is
// what guarantees ssh fails fast instead of hanging on one).
function ssh(host, remoteCommand) {
  const res = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `blaise@${host}`, remoteCommand],
    { encoding: "utf8" }
  );
  if (res.error) {
    die(`ssh to ${host} failed to launch: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").trim();
    if (
      res.status === 255 ||
      /permission denied|publickey|authentication failed|no route to host|could not resolve/i.test(
        stderr
      )
    ) {
      die(
        `SSH to blaise@${host} failed (key auth or connectivity), stopping — will NOT fall back ` +
          `to a password prompt. Details: ${stderr || `exit ${res.status}`}\n` +
          `Fix key auth or reachability and re-run.`
      );
    }
    die(`remote command on ${host} exited ${res.status}: ${stderr}`);
  }
  return res.stdout;
}

const REMOTE_PATH_PREFIX = 'export PATH="$HOME/.local/share/t3-node/bin:$PATH"; ';
function t3Remote(host, t3Version, args) {
  const cmd = `${REMOTE_PATH_PREFIX}env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@${t3Version} ${args}`;
  return ssh(host, cmd);
}

// --- HTTPS orchestration API ------------------------------------------------
async function apiGet(baseUrl, bearer, urlPath) {
  const res = await fetch(baseUrl + urlPath, { headers: { Authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function apiPost(baseUrl, bearer, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function nowIso() {
  return new Date().toISOString();
}
function uuid() {
  return crypto.randomUUID();
}

// --- config file -------------------------------------------------------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "{}\n", { mode: 0o600 });
  }
  fs.chmodSync(CONFIG_PATH, 0o600);
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`could not parse ${CONFIG_PATH}: ${e.message}`);
  }
}

function saveConfigEntry(host, entry) {
  const cfg = loadConfig();
  cfg[host] = entry;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}

// --- step 6: mint/rotate the bearer, over SSH -------------------------------
// Not idempotent by default: a naive re-run mints a second bearer and
// orphans the first (every token is access:write, i.e. root-equivalent on
// that box). Guard: list existing sessions for `label`, revoke any before
// minting the replacement. Rotate-on-rerun, not skip-if-present — this is
// also how a re-run refreshes an about-to-expire credential.
function mintBearer(host, t3Version, label) {
  const listOut = t3Remote(host, t3Version, "auth session list --json");
  let sessions = [];
  try {
    sessions = JSON.parse(listOut);
  } catch {
    die(`could not parse "auth session list --json" output from ${host}`);
  }
  const stale = sessions.filter((s) => s?.client?.label === label);
  for (const s of stale) {
    log(`  rotating: revoking existing "${label}" session ${s.sessionId}`);
    t3Remote(host, t3Version, `auth session revoke ${s.sessionId}`);
  }
  const issueOut = t3Remote(host, t3Version, `auth session issue --label ${label} --json`);
  let issued;
  try {
    issued = JSON.parse(issueOut);
  } catch {
    die(
      `could not parse "auth session issue --json" output from ${host} ` +
        `(--token-only is known to print nothing — this script uses --json and reads .token)`
    );
  }
  if (!issued.token) {
    die(`"auth session issue --json" on ${host} did not include a .token field`);
  }
  log(`  minted session ${issued.sessionId} (label "${label}")`);
  return issued.token; // caller writes this straight to config; never logged
}

// --- step 5: create the default project, snapshot-guarded ------------------
// Not idempotent by default: a second project.create at a workspaceRoot that
// already has one returns a generic 500, indistinguishable from a real
// server error. Guard: check the snapshot first, only create if absent.
async function ensureProject(baseUrl, bearer, workspaceRoot, title) {
  const snap = await apiGet(baseUrl, bearer, "/api/orchestration/snapshot");
  if (!snap.ok) {
    die(`GET /snapshot failed: HTTP ${snap.status} ${JSON.stringify(snap.json)}`);
  }
  const existing = (snap.json.projects || []).find((p) => p.workspaceRoot === workspaceRoot);
  if (existing) {
    log(`  project already exists for ${workspaceRoot}: ${existing.id || existing.projectId}`);
    return existing;
  }
  const projectId = uuid();
  const res = await apiPost(baseUrl, bearer, "/api/orchestration/dispatch", {
    type: "project.create",
    commandId: uuid(),
    projectId,
    title,
    workspaceRoot,
    createdAt: nowIso(),
  });
  if (!res.ok) {
    // 400 here almost always means workspaceRoot doesn't exist on the
    // target box (mkdir -p it, step 1-4 phase, then re-run).
    die(
      `project.create failed: HTTP ${res.status} ${JSON.stringify(res.json)}\n` +
        `If this is a 400, the workspaceRoot directory probably doesn't exist on ${baseUrl} yet ` +
        `— mkdir -p it over SSH and re-run.`
    );
  }
  log(`  created project ${projectId} for ${workspaceRoot}`);
  return { id: projectId, workspaceRoot, title };
}

// --- step 7: four verification checks ---------------------------------------
async function pollThread(baseUrl, bearer, threadId, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  while (true) {
    const res = await apiGet(baseUrl, bearer, `/api/orchestration/threads/${threadId}`);
    if (!res.ok) return { thread: null, timedOut: false, error: res };
    const state = res.json?.thread?.latestTurn?.state;
    if (state !== undefined && state !== null && state !== "running") {
      return { thread: res.json.thread, timedOut: false };
    }
    if (Date.now() >= deadline) {
      return { thread: res.json.thread, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function verify(host, baseUrl, bearer, workspaceRoot, project) {
  const results = {};

  // check 1: daemon up
  try {
    const out = ssh(host, "systemctl --user is-active t3code.service").trim();
    results.daemonActive = out === "active";
    log(`  [1/4] daemon active: ${out} -> ${results.daemonActive ? "PASS" : "FAIL"}`);
  } catch (e) {
    results.daemonActive = false;
    log(`  [1/4] daemon active: FAIL (${e.message || e})`);
  }

  // check 2: reachable over the tailnet with the bearer (200); unauthenticated
  // control request should be 401.
  const authed = await apiGet(baseUrl, bearer, "/api/orchestration/snapshot");
  results.reachableAuthed = authed.ok;
  log(`  [2/4] reachable+authed (expect 200): HTTP ${authed.status} -> ${results.reachableAuthed ? "PASS" : "FAIL"}`);
  const unauthedRes = await fetch(baseUrl + "/api/orchestration/snapshot");
  const unauthedOk = unauthedRes.status === 401;
  log(`  [2/4] unauthenticated control (expect 401): HTTP ${unauthedRes.status} -> ${unauthedOk ? "PASS" : "WARN (non-fatal)"}`);

  // check 3: project exists
  const projects = authed.ok ? authed.json.projects || [] : [];
  results.projectExists = projects.some((p) => p.workspaceRoot === workspaceRoot);
  log(`  [3/4] project exists for ${workspaceRoot}: ${results.projectExists ? "PASS" : "FAIL"}`);

  // check 4: an agent actually runs (the only check that proves the provider
  // CLI is authenticated — read from message content, since a provider
  // failure is HTTP 200 with a normal-looking assistant message)
  let pongOk = false;
  const projectId = project.id || project.projectId;
  const threadId = uuid();
  try {
    const create = await apiPost(baseUrl, bearer, "/api/orchestration/dispatch", {
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId,
      title: "t3-fleet-onboard verification",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5", options: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: nowIso(),
    });
    if (!create.ok) throw new Error(`thread.create HTTP ${create.status}: ${JSON.stringify(create.json)}`);

    const start = await apiPost(baseUrl, bearer, "/api/orchestration/dispatch", {
      type: "thread.turn.start",
      commandId: uuid(),
      threadId,
      message: { messageId: uuid(), role: "user", text: "Reply with exactly: pong", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: nowIso(),
    });
    if (!start.ok) throw new Error(`thread.turn.start HTTP ${start.status}: ${JSON.stringify(start.json)}`);

    const { thread, timedOut } = await pollThread(baseUrl, bearer, threadId, VERIFY_TIMEOUT_S);
    const state = thread?.latestTurn?.state;
    const messages = thread?.messages || [];
    const assistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
    const text = assistantMsg?.text || "";
    pongOk = !timedOut && state === "completed" && text.trim().toLowerCase().includes("pong");
    log(
      `  [4/4] agent dispatch (state=${state}${timedOut ? ", TIMED OUT" : ""}): ` +
        `"${text.trim().slice(0, 80)}" -> ${pongOk ? "PASS" : "FAIL"}`
    );
    if (!pongOk && !timedOut && text) {
      log(`        (this reads as a provider-level failure surfaced as a normal HTTP 200 message — check provider auth/credits)`);
    }
  } catch (e) {
    log(`  [4/4] agent dispatch: FAIL (${e.message || e})`);
  } finally {
    // Always try to clean up the verification thread, pass or fail.
    await apiPost(baseUrl, bearer, "/api/orchestration/dispatch", {
      type: "thread.delete",
      commandId: uuid(),
      threadId,
      createdAt: nowIso(),
    }).catch(() => {});
  }
  results.agentRuns = pongOk;

  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  gateOwnership(opts.host);

  const baseUrl = `https://${opts.host}.tail2b35ba.ts.net`;
  log(`onboarding ${opts.host} (${baseUrl})`);
  log(`workspaceRoot=${opts.workspaceRoot} title="${opts.title}" label=${opts.label} t3=${opts.t3Version}`);

  log("step 6: mint/rotate bearer over SSH");
  const bearer = mintBearer(opts.host, opts.t3Version, opts.label);
  saveConfigEntry(opts.host, { baseUrl, bearer });
  log(`  wrote ${CONFIG_PATH} (mode 0600) — token not shown`);

  log("step 5: ensure default project (snapshot-guarded)");
  const project = await ensureProject(baseUrl, bearer, opts.workspaceRoot, opts.title);

  if (opts.skipVerify) {
    log("skipping step 7 verification (--skip-verify)");
    return;
  }

  log("step 7: verification (4 checks)");
  const results = await verify(opts.host, baseUrl, bearer, opts.workspaceRoot, project);
  const allPass = Object.values(results).every(Boolean);

  log("");
  log(`summary: daemonActive=${results.daemonActive} reachableAuthed=${results.reachableAuthed} ` +
      `projectExists=${results.projectExists} agentRuns=${results.agentRuns}`);
  if (allPass) {
    log(`${opts.host}: ONBOARDING VERIFIED (all 4 checks passed)`);
  } else {
    die(`${opts.host}: ONBOARDING FAILED — not all checks passed (see above). This run counts as FAILED, not partial.`);
  }
}

main().catch((e) => die(e.stack || String(e)));
