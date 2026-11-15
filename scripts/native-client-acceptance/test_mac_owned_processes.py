"""Process ownership logic only; these tests never enumerate or signal real processes."""
import unittest

try:
    from mac_owned_processes import OwnedProcessTracker
except ImportError:
    OwnedProcessTracker = None


def actor(pid, parent, birth=1, path='/owned/node', status=2):
    return {'pid': pid, 'parent': parent, 'birthSeconds': birth,
            'birthMicroseconds': 123, 'path': path, 'status': status}


class FakeTable:
    def __init__(self):
        self.rows = {10: actor(10, 1), 11: actor(11, 10, path='/owned/adapter'),
                     12: actor(12, 11, path='/owned/helper'), 90: actor(90, 1, path='/unrelated/app')}
        self.queries = []
        self.after_children = None

    def info(self, pid):
        self.queries.append(('info', pid))
        value = self.rows.get(pid)
        return dict(value) if value else None

    def children(self, pid):
        self.queries.append(('children', pid))
        values = [key for key, row in self.rows.items() if row['parent'] == pid]
        if self.after_children:
            self.after_children(self, pid)
        return values


class OwnershipTests(unittest.TestCase):
    def tracker(self):
        self.assertTrue(callable(OwnedProcessTracker), 'owned descendant tracker must be implemented')
        table = FakeTable()
        return table, OwnedProcessTracker(table, table.info(10))

    def test_walks_only_children_of_bound_root(self):
        table, tracker = self.tracker()
        self.assertEqual({row['pid'] for row in tracker.scan()}, {11, 12})
        self.assertFalse(any(pid == 90 for _, pid in table.queries))

    def test_root_reuse_rejects_new_descendants(self):
        table, tracker = self.tracker()
        table.rows[10]['birthMicroseconds'] += 1
        with self.assertRaisesRegex(ValueError, 'root'):
            tracker.scan()
        self.assertEqual(tracker.live_owned(), [])

    def test_parent_reuse_during_walk_does_not_register_child(self):
        table, tracker = self.tracker()
        def replace_parent(table, pid):
            if pid == 11:
                table.rows[11]['birthMicroseconds'] += 1
        table.after_children = replace_parent
        with self.assertRaisesRegex(ValueError, 'identity'):
            tracker.scan()
        self.assertEqual(tracker.live_owned(), [])

    def test_child_reparented_before_registration_is_rejected(self):
        table, tracker = self.tracker()
        def reparent_child(table, pid):
            if pid == 11:
                table.rows[12]['parent'] = 90
        table.after_children = reparent_child
        with self.assertRaisesRegex(ValueError, 'parent'):
            tracker.scan()
        self.assertEqual(tracker.live_owned(), [])

    def test_tracked_child_survives_reparenting_but_not_pid_reuse(self):
        table, tracker = self.tracker()
        tracker.scan()
        del table.rows[11]
        table.rows[12]['parent'] = 1
        self.assertEqual([row['pid'] for row in tracker.live_owned()], [12])
        table.rows[12]['birthMicroseconds'] += 1
        self.assertEqual(tracker.live_owned(), [])

    def test_same_birth_exec_change_is_unresolved_instead_of_reaped(self):
        table, tracker = self.tracker()
        tracker.scan()
        table.rows[12]['path'] = '/different/helper'
        with self.assertRaisesRegex(ValueError, 'executable'):
            tracker.remaining_owned()
        with self.assertRaisesRegex(ValueError, 'executable'):
            tracker.live_owned()

    def test_zombie_is_not_live_but_remains_owned_and_unreaped(self):
        table, tracker = self.tracker()
        tracker.scan()
        table.rows[11]['status'] = 5
        self.assertEqual([row['pid'] for row in tracker.live_owned()], [12])
        self.assertEqual({row['pid'] for row in tracker.remaining_owned()}, {11, 12})


if __name__ == '__main__':
    unittest.main()
