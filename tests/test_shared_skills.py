import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "plugins/t3-fleet/skills/t3-fleet-onboard/scripts/share-skills.py"
spec = importlib.util.spec_from_file_location("share_skills", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SharedSkillsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / ".claude/plugins").mkdir(parents=True)

    def plugin(self, version, skills=("t3-fleet-delegate",)):
        root = self.home / ".claude/plugins/cache/blaise-skills/t3-fleet" / version
        for name in skills:
            path = root / "skills" / name
            path.mkdir(parents=True)
            (path / "SKILL.md").write_text("---\nname: " + name + "\ndescription: Test skill\n---\n")
        runner = root / "skills/t3-fleet-onboard/scripts/claude-skills-sync.sh"
        runner.parent.mkdir(parents=True, exist_ok=True)
        runner.write_text("#!/bin/sh\n# " + version + "\n")
        (self.home / ".claude/plugins/installed_plugins.json").write_text(json.dumps({
            "plugins": {"t3-fleet@blaise-skills": [{"scope": "user", "installPath": str(root)}]}
        }))
        return root

    def test_updates_same_files_and_stable_runner(self):
        first = self.plugin("first")
        module.sync(self.home)
        link = self.home / ".agents/skills/t3-fleet-delegate"
        self.assertTrue(link.is_symlink())
        self.assertTrue((link / "SKILL.md").samefile(first / "skills/t3-fleet-delegate/SKILL.md"))
        second = self.plugin("second")
        module.sync(self.home)
        self.assertTrue((link / "SKILL.md").samefile(second / "skills/t3-fleet-delegate/SKILL.md"))
        self.assertIn("second", (self.home / ".local/bin/claude-skills-sync").read_text())
        module.sync(self.home)  # Re-running must be harmless.

    def test_disabled_plugin_removes_only_owned_links(self):
        self.plugin("first", ("t3-fleet-delegate", "t3-fleet-onboard"))
        module.sync(self.home)
        changed = self.home / ".agents/skills/t3-fleet-onboard"
        changed.unlink()
        changed.mkdir()
        (changed / "personal-file").write_text("keep")
        (self.home / ".claude/settings.json").write_text(json.dumps({
            "enabledPlugins": {"t3-fleet@blaise-skills": False}
        }))
        module.sync(self.home)
        self.assertFalse((self.home / ".agents/skills/t3-fleet-delegate").is_symlink())
        self.assertEqual((changed / "personal-file").read_text(), "keep")

    def test_collision_does_not_overwrite_or_partially_install(self):
        self.plugin("first", ("t3-fleet-delegate", "t3-fleet-onboard"))
        collision = self.home / ".agents/skills/t3-fleet-onboard"
        collision.mkdir(parents=True)
        (collision / "SKILL.md").write_text("personal skill")
        with self.assertRaisesRegex(RuntimeError, "unmanaged path"):
            module.sync(self.home)
        self.assertEqual((collision / "SKILL.md").read_text(), "personal skill")
        self.assertFalse((self.home / ".agents/skills/t3-fleet-delegate").exists())


if __name__ == "__main__":
    unittest.main()
