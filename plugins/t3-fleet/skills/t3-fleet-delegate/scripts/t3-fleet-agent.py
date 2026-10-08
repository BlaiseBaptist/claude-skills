#!/usr/bin/env python3
"""Control real T3 threads via fleet SSH and T3 0.0.45's local HTTP API.

No third-party dependencies, stored credentials, or T3 source changes.
"""

import argparse
import base64
import datetime
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


# Only live, in-scope boxes from fleet.md. IPs avoid stale LAN DNS on war.
FLEET = {
    "archlinux": "100.91.183.24",
    "war": "100.79.164.88",
    "blaises-mini": "100.67.231.41",
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def local_cli():
    runtime = Path.home() / ".t3/runtime"
    state = runtime / "service-state.json"
    if state.exists():
        version = json.loads(state.read_text())["activeVersion"]
    else:
        # Desktop app: use its installed version, not an unrelated npm release.
        import plistlib
        bundles = [Path("/Applications/T3 Code (Alpha).app"), Path.home() / "Applications/T3 Code (Alpha).app"]
        bundle = next((p for p in bundles if p.exists()), None)
        if bundle is None:
            raise RuntimeError("Cannot locate the T3 desktop app or service state")
        with (bundle / "Contents/Info.plist").open("rb") as f:
            version = plistlib.load(f)["CFBundleShortVersionString"]
    cli = runtime / "versions" / version / "t3"
    if not cli.is_file():
        raise RuntimeError("The running version's T3 executable is missing")
    if version != "0.0.45":
        raise RuntimeError("This helper supports T3 0.0.45; recheck the API before using another version")
    return str(cli)


def summarize(thread):
    turn = thread.get("latestTurn") or {}
    session = thread.get("session") or {}
    state = turn.get("state", "pending")
    if session.get("status") == "error":
        state = "error"
    return {
        "threadId": thread["id"],
        "title": thread["title"],
        "modelSelection": thread["modelSelection"],
        "runtimeMode": thread["runtimeMode"],
        "interactionMode": thread["interactionMode"],
        "worktreePath": thread.get("worktreePath"),
        "state": state,
        "sessionStatus": session.get("status"),
        "lastError": session.get("lastError"),
        "messages": [{k: m.get(k) for k in ("id", "role", "text")} for m in thread.get("messages", [])],
    }


def worker(request):
    cli = local_cli()
    env = os.environ.copy()
    env.pop("T3_SERVICE_LAUNCHER_CONTEXT", None)
    issued = subprocess.run([cli, "auth", "session", "issue", "--ttl", "2m", "--label", "t3-fleet-agent", "--json"],
                            env=env, capture_output=True, text=True, timeout=15)
    if issued.returncode:
        raise RuntimeError("T3 credential issuance failed; credential output withheld")
    auth = json.loads(issued.stdout)
    token = auth["token"]

    def api(path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request("http://127.0.0.1:3773" + path, data=data,
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            # Keep a local credential local, even when a box exports HTTP_PROXY.
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace").replace(token, "[REDACTED]")
            raise RuntimeError("T3 HTTP %s: %s" % (error.code, detail[:2000])) from None

    def dispatch(payload):
        return api("/api/orchestration/dispatch", payload)

    def read(thread_id):
        return api("/api/orchestration/threads/" + thread_id)["thread"]

    try:
        action = request["action"]
        if action == "projects":
            snapshot = api("/api/orchestration/shell")
            return {"projects": [{k: p.get(k) for k in ("id", "title", "workspaceRoot", "defaultModelSelection")} for p in snapshot["projects"]]}
        if action == "start":
            root = Path(request["cwd"]).expanduser().resolve()
            if not root.is_dir():
                raise RuntimeError("Workspace does not exist on the target: " + str(root))
            projects = api("/api/orchestration/shell")["projects"]
            project = next((p for p in projects if p["workspaceRoot"] == str(root) and not p.get("deletedAt")), None)
            if project is None:
                raise RuntimeError("Add this workspace as a T3 project on the target first")
            worktree = request.get("worktree")
            if worktree:
                worktree = str(Path(worktree).expanduser().resolve())
                registered = subprocess.run(["git", "-C", str(root), "worktree", "list", "--porcelain"], capture_output=True, text=True, timeout=10)
                if registered.returncode or "worktree " + worktree not in registered.stdout.splitlines():
                    raise RuntimeError("--worktree must be an existing git worktree of the target project")
            branch_result = subprocess.run(["git", "-C", worktree or str(root), "symbolic-ref", "--short", "HEAD"],
                                           capture_output=True, text=True, timeout=10)
            branch = branch_result.stdout.strip() if branch_result.returncode == 0 else None
            if request.get("branch") and request["branch"] != branch:
                raise RuntimeError("--branch must match the target checkout's current branch")
            selection = {"instanceId": request["provider"], "model": request["model"], "options": request["options"]}
            namespace = uuid.uuid5(uuid.NAMESPACE_URL, "t3-fleet-agent:" + request["requestId"])
            thread_id = str(uuid.uuid5(namespace, "thread"))
            message_id = str(uuid.uuid5(namespace, "message"))
            timestamp = now()
            try:
                thread = read(thread_id)
            except RuntimeError as error:
                if "T3 HTTP 404:" not in str(error):
                    raise
                thread = None
            if thread is None:
                dispatch({"type": "thread.create", "commandId": str(uuid.uuid5(namespace, "create")),
                          "threadId": thread_id, "projectId": project["id"], "title": request["title"],
                          "modelSelection": selection, "runtimeMode": request["runtimeMode"],
                          "interactionMode": request["interactionMode"], "branch": branch,
                          "worktreePath": worktree, "createdAt": timestamp})
                thread = read(thread_id)
            elif (thread["projectId"] != project["id"] or thread["modelSelection"] != selection
                  or thread.get("worktreePath") != worktree or thread["runtimeMode"] != request["runtimeMode"]
                  or thread["interactionMode"] != request["interactionMode"]):
                raise RuntimeError("Request ID already belongs to a thread with different settings")
            existing = next((m for m in thread.get("messages", []) if m["id"] == message_id), None)
            if existing and existing.get("text") != request["prompt"]:
                raise RuntimeError("Request ID already belongs to a different prompt")
            if not existing:
                dispatch({"type": "thread.turn.start", "commandId": str(uuid.uuid5(namespace, "start")),
                          "threadId": thread_id, "message": {"messageId": message_id, "role": "user", "text": request["prompt"], "attachments": []},
                          "modelSelection": selection, "runtimeMode": request["runtimeMode"],
                          "interactionMode": request["interactionMode"], "createdAt": thread["createdAt"]})
        else:
            thread_id = request["threadId"]
            if action in ("interrupt", "archive", "unarchive"):
                command = {"type": "thread.turn.interrupt" if action == "interrupt" else "thread." + action,
                           "commandId": str(uuid.uuid4()), "threadId": thread_id}
                if action == "interrupt":
                    command["createdAt"] = now()
                dispatch(command)
                if action == "archive":
                    # Archived threads are hidden from the detail endpoint.
                    return {"threadId": thread_id, "archived": True}
        deadline = time.monotonic() + request.get("wait", 0)
        while True:
            result = summarize(read(thread_id))
            if result["state"] in ("completed", "interrupted", "error") or time.monotonic() >= deadline:
                result["waitTimedOut"] = request.get("wait", 0) > 0 and result["state"] not in ("completed", "interrupted", "error")
                return result
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    finally:
        revoked = subprocess.run([cli, "auth", "session", "revoke", auth["sessionId"]], env=env,
                                 capture_output=True, text=True, timeout=15)
        if revoked.returncode:
            print("Temporary session revocation failed; it expires after two minutes", file=sys.stderr)


def main():
    if sys.argv[1:] == ["--worker"]:
        try:
            print(json.dumps(worker(json.load(sys.stdin))))
        except Exception as error:
            print(json.dumps({"error": str(error)}))
            return 1
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("machine", choices=FLEET)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("projects", help="List existing projects and their model defaults")
    start = commands.add_parser("start", help="Create a visible T3 thread; read its prompt from stdin")
    start.add_argument("--cwd", required=True, help="Existing project directory on the TARGET box")
    start.add_argument("--provider", required=True, help="T3 provider instance ID, e.g. codex or claudeAgent")
    start.add_argument("--model", required=True)
    start.add_argument("--options", default="{}", help='Model options as JSON, e.g. {"reasoningEffort":"high"}')
    start.add_argument("--runtime-mode", choices=("approval-required", "auto-accept-edits", "full-access"), default="approval-required")
    start.add_argument("--interaction-mode", choices=("default", "plan"), default="default")
    start.add_argument("--title", default="Fleet delegated task")
    start.add_argument("--worktree", help="Existing git worktree on the target; otherwise uses the project checkout")
    start.add_argument("--branch", help="Branch metadata for an existing checkout/worktree; does not switch branches")
    start.add_argument("--request-id", help="Reuse this ID to retry the same launch without duplicating work")
    start.add_argument("--wait", type=int, choices=range(0, 51), metavar="0..50", default=0)
    for action in ("read", "wait", "interrupt", "archive", "unarchive"):
        command = commands.add_parser(action)
        command.add_argument("thread_id", type=lambda value: str(uuid.UUID(value)))
        if action == "wait":
            command.add_argument("--wait", type=int, choices=range(1, 51), metavar="1..50", default=45)
    args = parser.parse_args()
    request = {"action": args.action, "wait": getattr(args, "wait", 0)}
    if args.action == "start":
        prompt = sys.stdin.read().strip()
        if not prompt:
            parser.error("Provide a nonempty task prompt on stdin")
        options = json.loads(args.options)
        if not isinstance(options, dict) or any(not isinstance(v, (str, bool)) for v in options.values()):
            parser.error("--options must map option IDs to string or boolean values")
        request.update(cwd=args.cwd, provider=args.provider, model=args.model,
                       options=[{"id": k, "value": v} for k, v in options.items()],
                       runtimeMode=args.runtime_mode, interactionMode=args.interaction_mode,
                       title=args.title, prompt=prompt, worktree=args.worktree, branch=args.branch,
                       requestId=args.request_id or str(uuid.uuid4()))
        print(json.dumps({"machine": args.machine, "requestId": request["requestId"]}), file=sys.stderr, flush=True)
    elif args.action != "projects":
        request["threadId"] = args.thread_id
    hostname = socket.gethostname().lower().split(".")[0]
    if hostname == args.machine:
        result = worker(request)
    else:
        fqdn = args.machine + ".tail2b35ba.ts.net"
        source = base64.b64encode(Path(__file__).read_bytes()).decode()
        code = "import base64,sys;sys.argv=['t3-fleet-agent','--worker'];exec(base64.b64decode(" + repr(source) + "))"
        process = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                                  "-o", "HostName=" + FLEET[args.machine], "-o", "HostKeyAlias=" + fqdn,
                                  "blaise@" + fqdn, "python3 -c " + shlex.quote(code)],
                                 input=json.dumps(request), text=True, capture_output=True, timeout=100)
        if process.stderr:
            print(process.stderr.strip(), file=sys.stderr)
        if process.returncode:
            try:
                remote_error = json.loads(process.stdout).get("error")
            except (ValueError, AttributeError):
                remote_error = None
            raise RuntimeError(remote_error or "Target unreachable or remote helper failed")
        result = json.loads(process.stdout)
    result["machine"] = args.machine
    print(json.dumps(result, indent=2))
    return 1 if result.get("state") == "error" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
