"""Isolated stand-in for VS Code's PTY host. Never attaches to an existing terminal."""
import json, os, pty, select, signal, sys

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
print(json.dumps({"pid": pid}), flush=True)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.05)
        if master in ready:
            try:
                data = os.read(master, 65536)
                if data:
                    print(json.dumps({"output": data.decode(errors="replace")}), flush=True)
            except OSError:
                pass
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                break
            msg = json.loads(line)
            if "input" in msg:
                os.write(master, msg["input"].encode())
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            print(json.dumps({"exit": os.waitstatus_to_exitcode(status)}), flush=True)
            pid = None
            break
finally:
    if pid:
        # Only this fixture's newly allocated process group, never a discovered user process.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(master)
