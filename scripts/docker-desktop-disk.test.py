import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('disk', Path(__file__).with_name('docker-desktop-disk.py'))
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


class DiskCapacityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'settings.json'
        self.data = {'DiskSizeMiB': 32768, 'OtherSetting': {'keep': '原值'}}
        self.path.write_text(json.dumps(self.data))
        self.path.chmod(0o600)

    def test_increase_preserves_other_settings_and_backup(self):
        backup = Path(self.directory.name) / 'backups'
        disk.extend_settings(self.path, 49152, self.data, backup)
        self.assertEqual(json.loads(self.path.read_text()), {**self.data, 'DiskSizeMiB': 49152})
        saved = next(backup.iterdir())
        self.assertEqual(json.loads(saved.read_text()), self.data)
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_shrink_fractional_and_invalid_rejected_without_writes(self):
        before = self.path.read_bytes()
        for target in [16384, 32769, True, -1024]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                disk.read_settings(self.path, target)
        self.assertEqual(before, self.path.read_bytes())

    def test_equal_target_and_missing_setting(self):
        self.assertEqual(disk.read_settings(self.path, 32768)[1], 32768)
        self.path.write_text('{}')
        with self.assertRaises(ValueError):
            disk.read_settings(self.path, 49152)

    def test_concurrent_change_is_preserved(self):
        modified = {**self.data, 'OtherSetting': '并发修改'}
        self.path.write_text(json.dumps(modified))
        with self.assertRaises(RuntimeError):
            disk.extend_settings(self.path, 49152, self.data, Path(self.directory.name) / 'backups')
        self.assertEqual(json.loads(self.path.read_text()), modified)

    def test_symlink_rejected(self):
        linked = self.path.with_name('linked.json')
        linked.symlink_to(self.path)
        with self.assertRaises(ValueError):
            disk.read_settings(linked, 49152)

    def test_nonlocal_context_does_not_stop_desktop(self):
        with patch.object(disk.sys, 'argv', ['script', 'extend', '49152']), \
                patch.object(disk, 'read_settings', return_value=(self.data, 32768)), \
                patch.dict(disk.os.environ, {'DOCKER_HOST': '', 'BUILDX_BUILDER': ''}), \
                patch.object(disk, 'docker', return_value='remote') as command:
            with self.assertRaises(ValueError):
                disk.main()
            command.assert_called_once_with('context', 'show')

    def test_active_build_blocks_stop_and_releases_owned_lock(self):
        def command(*args):
            if args[:2] == ('context', 'show'):
                return 'desktop-linux'
            if args[:2] == ('context', 'inspect'):
                return 'unix:///local.sock'
            if args[0] == 'buildx':
                return 'Running'
            self.fail(f'活动构建时不应执行 {args}')
        with patch.object(disk.sys, 'argv', ['script', 'extend', '49152']), \
                patch.object(disk, 'read_settings', return_value=(self.data, 32768)), \
                patch.dict(disk.os.environ, {'DOCKER_HOST': '', 'BUILDX_BUILDER': ''}), \
                patch.object(disk.tempfile, 'gettempdir', return_value=self.directory.name), \
                patch.object(disk.subprocess, 'run', return_value=subprocess.CompletedProcess('cksum', 0, '1234 18\n')), \
                patch.object(disk, 'docker', side_effect=command):
            with self.assertRaises(RuntimeError):
                disk.main()
        self.assertEqual(list(Path(self.directory.name).glob('*.lock')), [])


if __name__ == '__main__':
    unittest.main()
