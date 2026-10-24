import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "file_status", Path(__file__).parents[1] / "scripts" / "probe-file-status.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def event(kind, turn="turn-a", **extra):
    return {"type": "event_msg", "timestamp": "2026-10-24T00:00:00Z",
            "payload": {"type": kind, "turn_id": turn, **extra}}


class FileStatusTest(unittest.TestCase):
    def test_partial_append_is_not_a_complete_event_or_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            content = json.dumps(event("task_started")).encode()
            path.write_bytes(content[:20])
            reader = module.RolloutReader(path)
            self.assertEqual(reader.poll()["executionObservation"], "unknown")
            with path.open("ab") as stream:
                stream.write(content[20:] + b"\n")
            self.assertEqual(reader.poll()["executionObservation"], "turn_started")
            self.assertEqual(reader.poll()["lifecycleEventsSeen"], 1)

    def test_old_completion_cannot_clear_a_new_turn(self):
        reader = module.RolloutReader("unused")
        reader.consume(event("task_started", "old"))
        reader.consume(event("task_started", "new"))
        reader.consume(event("task_complete", "old"))
        self.assertEqual((reader.observation, reader.turn_id), ("turn_started", "new"))

    def test_replaced_file_does_not_keep_old_started_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_text(json.dumps(event("task_started")) + "\n")
            reader = module.RolloutReader(path)
            self.assertEqual(reader.poll()["executionObservation"], "turn_started")
            replacement = Path(directory) / "replacement"
            replacement.write_text("{}\n")
            replacement.replace(path)
            self.assertEqual(reader.poll()["executionObservation"], "unknown")

    def test_ambiguous_accounts_are_unknown_not_unioned(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(json.dumps({"electron-thread-read-state-v1": {
                "unreadByIdentity": {"one": {"local:host": ["a"]},
                                     "two": {"local:host": ["b"]}}}}))
            self.assertIsNone(module.read_unread(path)[0])

    def test_single_account_local_host_preserves_unread_membership(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(json.dumps({"electron-thread-read-state-v1": {
                "unreadByIdentity": {"one": {"local:host": ["a"]}}}}))
            self.assertEqual(module.read_unread(path)[0], {"a"})

    def test_body_and_error_details_are_never_retained(self):
        reader = module.RolloutReader("unused")
        reader.consume(event("turn_aborted", prompt="private marker", error="private marker"))
        self.assertNotIn("private marker", json.dumps(reader.__dict__, default=str))
        self.assertEqual(reader.observation, "turn_interrupted")

    def test_changed_rollout_path_replaces_the_cached_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "sessions").mkdir()
            old = home / "sessions" / "old.jsonl"
            new = home / "sessions" / "new.jsonl"
            old.write_text(json.dumps(event("task_started")) + "\n")
            new.write_text(json.dumps(event("task_complete")) + "\n")
            readers = {}
            first = module.snapshot(home, [("a", str(old))], readers)
            second = module.snapshot(home, [("a", str(new))], readers)
            self.assertEqual(first["threads"][0]["executionObservation"], "turn_started")
            self.assertEqual(second["threads"][0]["executionObservation"], "turn_completed")


if __name__ == "__main__":
    unittest.main()
