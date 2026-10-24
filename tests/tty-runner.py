"""Run a CLI fixture with a real terminal while forwarding test input/output."""
import os
import pty
import select
import sys

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

while True:
    readable, _, _ = select.select([terminal, 0], [], [])
    if terminal in readable:
        try:
            data = os.read(terminal, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in readable:
        data = os.read(0, 65536)
        if data:
            os.write(terminal, data)

os.close(terminal)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
