import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('button_state_driver', ROOT / 'button-state-driver.py')
state_driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state_driver)


class CancellationModeTests(unittest.TestCase):
    def test_pointer_cancellation_rejects_unbound_signalling_before_any_setup(self):
        for script, extra in [('pointer-driver.py', []), ('button-state-driver.py', ['--preheld-button', '3'])]:
            with self.subTest(script=script):
                args = []
                for field in ['adapter', 'adapter-sha256', 'fixture-state', 'fixture-script', 'fixture-sha256', 'display', 'lease-expires', 'receipt']:
                    args.extend(['--' + field, 'not-a-real-resource'])
                for field in ['fixture-pid', 'server-pid', 'fixture-window']:
                    args.extend(['--' + field, '2'])
                result = subprocess.run([sys.executable, str(ROOT / script), *args, *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b'cancellation requires --trace-owned-helper', result.stderr)
                self.assertEqual(result.stdout, b'')


class CompletedButtonStateTests(unittest.TestCase):
    def qualify(self, button, restored, **changes):
        facts = dict(expected_buttons=1 if button == 1 else 4, observed_buttons=1 if button == 1 else 4,
                     keyboard_preserved=True, helper_reaped=True, preheld_button=button)
        facts.update(changes)
        return state_driver.completed_state_qualified(
            {'ok': True, 'cleanupState': 'verified', 'releasedButtons': 0, 'restoredButtons': restored}, **facts)

    def test_touched_preheld_left_button_requires_restoration(self):
        self.assertTrue(self.qualify(1, 1))
        self.assertFalse(self.qualify(1, 0))

    def test_unrelated_preheld_right_button_must_not_be_restored(self):
        self.assertTrue(self.qualify(3, 0))
        self.assertFalse(self.qualify(3, 1))

    def test_actual_state_and_reaping_are_required(self):
        self.assertFalse(self.qualify(1, 1, observed_buttons=0))
        self.assertFalse(self.qualify(1, 1, keyboard_preserved=False))
        self.assertFalse(self.qualify(1, 1, helper_reaped=False))


if __name__ == '__main__':
    unittest.main()
