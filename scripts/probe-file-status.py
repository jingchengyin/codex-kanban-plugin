"""Read-only observation of local Codex lifecycle records and desktop read state.

These are internal persisted formats, not a public runtime-status API. A started
turn without a terminal record is evidence, not proof a process is still running.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import time


def now():
    return datetime.now(timezone.utc).isoformat()


class RolloutReader:
    def __init__(self, path):
        self.path = Path(path)
        self.reset()

    def reset(self):
        self.identity = None
        self.offset = 0
        self.pending = b""
        self.observation = "unknown"
        self.turn_id = None
        self.last_lifecycle_at = None
        self.last_activity_at = None
        self.lifecycle_events = 0

    def poll(self):
        try:
            stat = self.path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if self.identity != identity or stat.st_size < self.offset:
                self.reset()
                self.identity = identity
            with self.path.open("rb") as stream:
                stream.seek(self.offset)
                chunk = stream.read()
                self.offset = stream.tell()
            lines = (self.pending + chunk).split(b"\n")
            self.pending = lines.pop()
            for line in lines:
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                self.consume(record)
            return {"sourceAvailable": True, "executionObservation": self.observation,
                    "turnId": self.turn_id, "lastLifecycleAt": self.last_lifecycle_at,
                    "lastActivityAt": self.last_activity_at,
                    "lifecycleEventsSeen": self.lifecycle_events,
                    "nativeRuntimeStatus": "unknown"}
        except OSError as error:
            return {"sourceAvailable": False, "executionObservation": "unknown",
                    "nativeRuntimeStatus": "unknown", "sourceError": type(error).__name__}

    def consume(self, record):
        if not isinstance(record, dict):
            return
        timestamp = record.get("timestamp")
        if isinstance(timestamp, str):
            self.last_activity_at = timestamp
        payload = record.get("payload")
        if record.get("type") != "event_msg" or not isinstance(payload, dict):
            return
        event = payload.get("type")
        if event not in ("task_started", "task_complete", "turn_aborted"):
            return
        turn_id = payload.get("turn_id")
        if event != "task_started" and self.turn_id and turn_id and turn_id != self.turn_id:
            return
        self.lifecycle_events += 1
        self.observation = {"task_started": "turn_started",
                            "task_complete": "turn_completed",
                            "turn_aborted": "turn_interrupted"}[event]
        self.turn_id = turn_id or self.turn_id
        self.last_lifecycle_at = timestamp


def read_unread(path):
    try:
        state = json.loads(Path(path).read_text())
        accounts = state.get("electron-thread-read-state-v1", {}).get("unreadByIdentity", {})
        if len(accounts) != 1:
            return None, "account_identity_ambiguous_or_missing"
        hosts = next(iter(accounts.values()))
        if not isinstance(hosts, dict) or len(hosts) != 1:
            return None, "host_identity_ambiguous_or_missing"
        key, ids = next(iter(hosts.items()))
        if not key.startswith("local:") or not isinstance(ids, list):
            return None, "unsupported_host_read_state"
        if any(not isinstance(item, str) for item in ids):
            return None, "unsupported_read_state_schema"
        return set(ids), "sole_persisted_account_and_local_host"
    except (OSError, ValueError, TypeError, AttributeError):
        return None, "read_state_unavailable"


def lookup_threads(codex_dir, ids, limit):
    database = codex_dir / "state_5.sqlite"
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if ids:
            rows = [connection.execute("SELECT id, rollout_path FROM threads WHERE id=?",
                                       (thread_id,)).fetchone() for thread_id in ids]
            return [(row[0], row[1]) if row else (thread_id, None)
                    for thread_id, row in zip(ids, rows)]
        return connection.execute(
            "SELECT id, rollout_path FROM threads WHERE archived=0 AND source='vscode' "
            "ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
    finally:
        connection.close()


def snapshot(codex_dir, threads, readers):
    codex_dir = Path(codex_dir).resolve()
    unread, selection = read_unread(codex_dir / ".codex-global-state.json")
    rows = []
    for thread_id, path in threads:
        allowed = False
        if path:
            resolved = Path(path).resolve()
            allowed = any(resolved.is_relative_to(codex_dir / folder)
                          for folder in ("sessions", "archived_sessions"))
        if allowed:
            reader = readers.get(thread_id)
            if reader is None or reader.path.resolve() != resolved:
                reader = readers[thread_id] = RolloutReader(path)
            row = reader.poll()
        else:
            row = {"sourceAvailable": False, "executionObservation": "unknown",
                   "nativeRuntimeStatus": "unknown"}
        row.update({"id": thread_id, "isUnread": None if unread is None else thread_id in unread,
                    "readStateSelection": selection,
                    "currentSignedInIdentityVerified": False,
                    "waitingOnApproval": None, "waitingOnUserInput": None,
                    "connectionStatus": "unknown"})
        rows.append(row)
    return {"checkedAt": now(), "source": "read-only local internal persisted formats",
            "limitations": ["No native runtime subscription",
                            "A missing terminal record does not prove live execution",
                            "No approval/input/connection status is inferred",
                            "Unread identity is accepted only with one account and one local host"],
            "threads": rows}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-dir", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")))
    parser.add_argument("--thread-id", action="append")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--output", type=Path, default=Path("outputs/file-observer-probe.json"))
    parser.add_argument("--watch-seconds", type=float, default=0)
    parser.add_argument("--poll-seconds", type=float, default=0.5)
    args = parser.parse_args()
    if args.limit < 1 or args.watch_seconds < 0 or args.poll_seconds < 0.1:
        parser.error("limit must be positive; watch-seconds >= 0; poll-seconds >= 0.1")
    codex_dir = args.codex_dir.resolve()
    readers = {}
    started = time.monotonic()
    changes = []
    previous = {}
    first_snapshot = True
    while True:
        threads = lookup_threads(codex_dir, args.thread_id, args.limit)
        result = snapshot(codex_dir, threads, readers)
        for row in result["threads"]:
            observed = (row["executionObservation"], row.get("turnId"), row["isUnread"])
            if row["id"] in previous and observed != previous[row["id"]]:
                change = {"observedAt": now(), "threadId": row["id"],
                          "executionObservation": row["executionObservation"],
                          "turnId": row.get("turnId"), "isUnread": row["isUnread"]}
                changes.append(change)
                print(json.dumps({"event": "observed_change", **change}), flush=True)
            previous[row["id"]] = observed
        result["changesObserved"] = changes
        result["elapsedSeconds"] = round(time.monotonic() - started, 3)
        save(args.output, result)
        if first_snapshot:
            print(json.dumps({"event": "snapshot_saved", "threadCount": len(threads),
                              "output": str(args.output)}), flush=True)
            first_snapshot = False
        if time.monotonic() - started >= args.watch_seconds:
            break
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
