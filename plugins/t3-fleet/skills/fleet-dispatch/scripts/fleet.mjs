#!/usr/bin/env node
// fleet.mjs — CLI for dispatching work to an already-onboarded T3 Code fleet box.
//
// Subcommands:
//   prompt <host> <project> <text> [--model NAME] [--timeout SECONDS]
//   result <host> <threadId> [--timeout SECONDS]
//   list <host>
//   interrupt <host> <threadId>
//   cleanup <host> <threadId>
//   approve <host> <threadId> <decision>   decision: accept|acceptForSession|decline|cancel
//
// Config: mode-0600 JSON at $FLEET_CONFIG (default ~/.config/fleet/hosts.json)
//   { "<host>": { "baseUrl": "https://<host>.tail2b35ba.ts.net", "bearer": "<token>" } }
//
// Never prints bearer tokens. Always exits non-zero on failure so callers can
// detect it without parsing prose.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const CONFIG_PATH =
  process.env.FLEET_CONFIG || path.join(os.homedir(), ".config", "fleet", "hosts.json");

const DEFAULT_TIMEOUT_S = 300; // wall-clock poll timeout; "running" can be stale forever
const POLL_INTERVAL_MS = 1500;
const DEFAULT_RUNTIME_MODE = "full-access";
const DEFAULT_INTERACTION_MODE = "default";

function die(msg, code = 1) {
  process.stderr.write(`fleet: ${msg}\n`);
  process.exit(code);
}

function usage() {
  process.stderr.write(`usage:
  fleet.mjs prompt <host> <project> <text> [--model NAME] [--timeout SECONDS]
  fleet.mjs result <host> <threadId> [--timeout SECONDS]
  fleet.mjs list <host>
  fleet.mjs interrupt <host> <threadId>
  fleet.mjs cleanup <host> <threadId>
  fleet.mjs approve <host> <threadId> <decision> [requestId]   (accept|acceptForSession|decline|cancel)
                                                                 requestId auto-detected from the
                                                                 thread's pending approval if omitted
`);
  process.exit(2);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    die(
      `no config at ${CONFIG_PATH} — create it (mode 0600) as ` +
        `{ "<host>": { "baseUrl": "https://<host>.tail2b35ba.ts.net", "bearer": "<token>" } }`
    );
  }
  const stat = fs.statSync(CONFIG_PATH);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    process.stderr.write(
      `fleet: warning: ${CONFIG_PATH} is mode ${mode.toString(8)}, expected 0600 — tightening it\n`
    );
    fs.chmodSync(CONFIG_PATH, 0o600);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`could not parse ${CONFIG_PATH}: ${e.message}`);
  }
  return cfg;
}

function hostConfig(cfg, host) {
  const entry = cfg[host];
  if (!entry || !entry.baseUrl || !entry.bearer) {
    die(
      `no entry for host "${host}" in ${CONFIG_PATH} (need baseUrl + bearer). ` +
        `Run t3-fleet-onboard first, or add the entry.`
    );
  }
  return entry;
}

// Bare-object envelope: the dispatch body is the command itself, NOT wrapped
// in {"command": ...}. Verified against archlinux 2026-08-11.
async function dispatch(entry, command) {
  return apiPost(entry, "/api/orchestration/dispatch", command);
}

async function apiPost(entry, urlPath, body) {
  const res = await fetch(entry.baseUrl + urlPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entry.bearer}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    // Errors are coarse (e.g. a nonexistent thread yields a generic 500, not
    // a 404) — surface status + traceId, don't pretend we know more.
    const traceId = json?.traceId || json?.error?.traceId || "(none)";
    die(
      `${urlPath} -> HTTP ${res.status} ${json?.error?.code || json?.code || ""} ` +
        `traceId=${traceId}\n${JSON.stringify(json)}`
    );
  }
  return json;
}

async function apiGet(entry, urlPath) {
  const res = await fetch(entry.baseUrl + urlPath, {
    headers: { Authorization: `Bearer ${entry.bearer}` },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const traceId = json?.traceId || json?.error?.traceId || "(none)";
    die(`${urlPath} -> HTTP ${res.status} traceId=${traceId}\n${JSON.stringify(json)}`);
  }
  return json;
}

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

// Poll GET /threads/:threadId until latestTurn.state !== "running", or until
// the wall-clock timeout fires. Per the design doc: do NOT poll the message
// list for completion (the assistant message only appears at completion,
// mid-run messages.length stays at 1), and do NOT enumerate terminal states
// (unknown values fall back to "running" server-side) — only test !== "running".
async function pollThread(entry, threadId, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let last;
  while (true) {
    last = await apiGet(entry, `/api/orchestration/threads/${threadId}`);
    const state = last?.thread?.latestTurn?.state;
    // A thread that was just created (or whose turn.start hasn't landed yet)
    // can briefly have no latestTurn at all — that is NOT completion, treat
    // it the same as "running" and keep polling. Only a defined, non-running
    // state counts as done.
    if (state !== undefined && state !== null && state !== "running") {
      return { thread: last.thread, timedOut: false };
    }
    if (Date.now() >= deadline) {
      return { thread: last.thread, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function lastAssistantMessage(thread) {
  const messages = thread?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return null;
}

function messageText(message) {
  if (!message) return "(no assistant message)";
  if (typeof message.text === "string") return message.text;
  if (Array.isArray(message.content)) {
    return message.content
      .map((c) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
      .join("");
  }
  return JSON.stringify(message);
}

function resolveModelSelection(project, modelOverride) {
  if (modelOverride) {
    return {
      instanceId: "claudeAgent",
      model: modelOverride,
      options: [],
    };
  }
  if (project?.defaultModelSelection) {
    return project.defaultModelSelection;
  }
  return {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [],
  };
}

async function resolveProject(entry, projectRef) {
  const snapshot = await apiGet(entry, "/api/orchestration/snapshot");
  const projects = snapshot.projects || [];
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let project;
  if (uuidRe.test(projectRef)) {
    project = projects.find((p) => p.id === projectRef || p.projectId === projectRef);
  }
  if (!project) {
    project = projects.find((p) => p.title === projectRef);
  }
  if (!project) {
    die(
      `no project matching "${projectRef}" on this host. Known projects:\n` +
        projects.map((p) => `  ${p.id || p.projectId}  ${p.title}  (${p.workspaceRoot})`).join("\n")
    );
  }
  return project;
}

function reportTurnOutcome(thread, timedOut) {
  const state = thread?.latestTurn?.state;
  const msg = lastAssistantMessage(thread);
  const text = messageText(msg);
  process.stdout.write(`threadId: ${thread?.id || thread?.threadId}\n`);
  process.stdout.write(`state: ${state}${timedOut ? " (TIMED OUT waiting)" : ""}\n`);
  process.stdout.write(`---\n${text}\n`);
  // Provider failures return HTTP 200 with a normal assistant message (e.g.
  // "out of usage credits") — status codes and latestTurn.state won't catch
  // that. We can't reliably detect it from content alone, so we always print
  // the raw text and let the caller judge; we DO fail loudly on explicit
  // error state or timeout.
  if (timedOut) {
    process.exitCode = 1;
  } else if (state === "error") {
    process.stderr.write(`fleet: turn ended in error state\n`);
    if (thread?.session?.lastError) {
      process.stderr.write(`lastError: ${JSON.stringify(thread.session.lastError)}\n`);
    }
    process.exitCode = 1;
  } else if (state === "interrupted") {
    process.exitCode = 1;
  }
}

async function cmdPrompt(args) {
  const [host, projectRef, ...rest] = args;
  if (!host || !projectRef || rest.length === 0) usage();
  let timeout = DEFAULT_TIMEOUT_S;
  let model = null;
  const textParts = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--timeout") {
      timeout = Number(rest[++i]);
    } else if (rest[i] === "--model") {
      model = rest[++i];
    } else {
      textParts.push(rest[i]);
    }
  }
  const text = textParts.join(" ");
  if (!text) usage();

  const cfg = loadConfig();
  const entry = hostConfig(cfg, host);
  const project = await resolveProject(entry, projectRef);
  const projectId = project.id || project.projectId;

  const threadId = uuid();
  const modelSelection = resolveModelSelection(project, model);

  await dispatch(entry, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title: `fleet-dispatch: ${text.slice(0, 60)}`,
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: nowIso(),
  });

  await dispatch(entry, {
    type: "thread.turn.start",
    commandId: uuid(),
    threadId,
    message: { messageId: uuid(), role: "user", text, attachments: [] },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    createdAt: nowIso(),
  });

  const { thread, timedOut } = await pollThread(entry, threadId, timeout);
  reportTurnOutcome(thread, timedOut);
}

async function cmdResult(args) {
  const [host, threadId, ...rest] = args;
  if (!host || !threadId) usage();
  let timeout = DEFAULT_TIMEOUT_S;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--timeout") timeout = Number(rest[++i]);
  }
  const cfg = loadConfig();
  const entry = hostConfig(cfg, host);
  const { thread, timedOut } = await pollThread(entry, threadId, timeout);
  reportTurnOutcome(thread, timedOut);
}

async function cmdList(args) {
  const [host] = args;
  if (!host) usage();
  const cfg = loadConfig();
  const entry = hostConfig(cfg, host);
  const snapshot = await apiGet(entry, "/api/orchestration/snapshot");
  const projects = snapshot.projects || [];
  const threads = snapshot.threads || [];
  process.stdout.write("projects:\n");
  for (const p of projects) {
    process.stdout.write(`  ${p.id || p.projectId}  ${p.title}  (${p.workspaceRoot})\n`);
  }
  process.stdout.write("threads:\n");
  for (const t of threads) {
    const state = t.latestTurn?.state ?? "(none)";
    process.stdout.write(`  ${t.id || t.threadId}  [${state}]  ${t.title || ""}\n`);
  }
}

async function cmdInterrupt(args) {
  const [host, threadId] = args;
  if (!host || !threadId) usage();
  const cfg = loadConfig();
  const entry = hostConfig(cfg, host);
  await dispatch(entry, {
    type: "thread.turn.interrupt",
    commandId: uuid(),
    threadId,
    createdAt: nowIso(),
  });
  process.stdout.write(`interrupted ${threadId}\n`);
}

async function cmdCleanup(args) {
  const [host, threadId] = args;
  if (!host || !threadId) usage();
  const cfg = loadConfig();
  const entry = hostConfig(cfg, host);
  await dispatch(entry, {
    type: "thread.delete",
    commandId: uuid(),
    threadId,
    createdAt: nowIso(),
  });
  process.stdout.write(`deleted ${threadId}\n`);
}

// Recursively hunt a thread object for a plausible pending-approval request
// id. The wire schema for thread.approval.respond needs a "requestId" field
// (confirmed by probing — NOT "approvalId", and NOT documented in the design
// doc's tool table at all). There's no known top-level "pendingApproval"
// field, so on a real approval prompt we look for a requestId near anything
// that mentions "approval".
function findRequestId(thread) {
  const seen = new Set();
  function walk(node, nearApproval) {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    const isApprovalish =
      nearApproval ||
      Object.entries(node).some(
        ([k, v]) => /approval/i.test(k) || (typeof v === "string" && /approval/i.test(v))
      );
    if (isApprovalish && typeof node.requestId === "string") return node.requestId;
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") {
        const found = walk(v, isApprovalish);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(thread, false);
}

async function cmdApprove(args) {
  const [host, threadId, decision, explicitRequestId] = args;
  const valid = ["accept", "acceptForSession", "decline", "cancel"];
  if (!host || !threadId || !valid.includes(decision)) {
    process.stderr.write(`decision must be one of: ${valid.join(", ")}\n`);
    usage();
  }
  const cfg = loadConfig();
  const entry = hostConfig(cfg, host);
  let requestId = explicitRequestId;
  if (!requestId) {
    const { thread } = await apiGet(entry, `/api/orchestration/threads/${threadId}`);
    requestId = findRequestId(thread);
    if (!requestId) {
      die(
        `no pending-approval requestId found on thread ${threadId}. ` +
          `Pass it explicitly: fleet.mjs approve <host> <threadId> <decision> <requestId>`
      );
    }
  }
  await dispatch(entry, {
    type: "thread.approval.respond",
    commandId: uuid(),
    threadId,
    requestId,
    decision,
    createdAt: nowIso(),
  });
  // Deliberately a separate subcommand (not folded into prompt/result) so
  // auto-approval is visible in transcripts rather than silent.
  process.stdout.write(`approval "${decision}" sent for ${threadId} (requestId ${requestId})\n`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "prompt":
      return cmdPrompt(args);
    case "result":
      return cmdResult(args);
    case "list":
      return cmdList(args);
    case "interrupt":
      return cmdInterrupt(args);
    case "cleanup":
      return cmdCleanup(args);
    case "approve":
      return cmdApprove(args);
    default:
      usage();
  }
}

main().catch((e) => die(e.stack || String(e)));
