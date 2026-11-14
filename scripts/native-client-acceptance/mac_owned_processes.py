"""Read-only ownership tracking for a separate macOS acceptance coordinator.

The injected table supplies process observations. This module never enumerates
global processes, signals actors, invokes a desktop helper or establishes reaping.
"""


def identity(row):
    if row is None:
        return None
    return (row['pid'], row['birthSeconds'], row['birthMicroseconds'], row['path'])


class OwnedProcessTracker:
    def __init__(self, table, root):
        if not root or root['pid'] <= 1 or root['birthMicroseconds'] < 0:
            raise ValueError('invalid owned root identity')
        self.table = table
        self.root = dict(root)
        self.owned = {}

    def scan(self):
        if identity(self.table.info(self.root['pid'])) != identity(self.root):
            raise ValueError('owned root identity changed')
        pending = {}
        visited = set()

        def visit(parent):
            pid = parent['pid']
            if pid in visited or len(visited) >= 256:
                raise ValueError('owned process traversal is cyclic or exceeds its bound')
            visited.add(pid)
            if identity(self.table.info(pid)) != identity(parent):
                raise ValueError('parent identity changed before traversal')
            children = self.table.children(pid)
            if len(children) > 256 or len(set(children)) != len(children):
                raise ValueError('invalid owned child list')
            for child_pid in children:
                child = self.table.info(child_pid)
                if child is None:
                    continue  # Already exited; no ownership or reaping claim.
                if child['parent'] != pid:
                    raise ValueError('child parent changed before ownership registration')
                if child_pid <= 1 or child_pid == self.root['pid']:
                    raise ValueError('invalid child identity')
                visit(child)
                after = self.table.info(child_pid)
                if after is None:
                    continue
                if identity(after) != identity(child) or after['parent'] != pid:
                    raise ValueError('child identity or parent changed during traversal')
                pending[identity(child)] = dict(child)
            if identity(self.table.info(pid)) != identity(parent):
                raise ValueError('parent identity changed during traversal')

        visit(self.root)
        if identity(self.table.info(self.root['pid'])) != identity(self.root):
            raise ValueError('owned root identity changed after traversal')
        # Commit only a complete, identity-checked traversal. Retain prior owned
        # identities so known helpers remain observable after reparenting.
        self.owned.update(pending)
        return list(pending.values())

    def remaining_owned(self):
        values = []
        for expected in self.owned.values():
            current = self.table.info(expected['pid'])
            if current is not None and identity(current)[:3] == identity(expected)[:3] and current['path'] != expected['path']:
                raise ValueError('owned actor changed executable; disappearance is unproved')
            if identity(current) == identity(expected):
                values.append(current)
        return values

    def live_owned(self):
        # Darwin SZOMB=5: a zombie is not active, but remaining_owned retains it.
        # Absence from this list alone never proves that a helper was reaped.
        return [row for row in self.remaining_owned() if row['status'] != 5]
