"""One agent launch owns this PTY process. No interactive shell survives the agent.

Linux subreaping keeps even double-forked/detached jobs alive until they exit. VS Code
closes the terminal on this process's exit, after waitpid and a fresh tty check.
No terminal lookup by title, no signal to a guessed PID, no shell-exit injection.
"""
import ctypes
import os
import re
import signal
import subprocess
import sys
import time


def proc_stat(pid, root):
    with open(f"{root}/{pid}/stat") as f:
        raw = f.read()
    fields = raw[raw.rindex(")") + 2:].split()
    return dict(state=fields[0], ppid=int(fields[1]), ttyNr=int(fields[4]), startTime=int(fields[19]))


def terminal_identity(pid, root="/proc"):
    try:
        p = proc_stat(pid, root)
        tty = os.readlink(f"{root}/{pid}/fd/0")
        if p["ttyNr"] and re.fullmatch(r"/dev/pts/\d+", tty):
            return dict(pid=pid, startTime=p["startTime"], tty=tty, ttyNr=p["ttyNr"])
    except (OSError, ValueError, IndexError):
        pass
    return None


def terminal_exit_blocker(identity, root="/proc"):
    """Extra fresh guard AFTER waitpid proves all owned descendants exited.

    Subreaping accounts for inherited tty descriptors even after setsid or double fork;
    this check also retains an unrelated process attached to the same controlling tty.
    Unreadable or stale identity is not permission to close anything.
    """
    try:
        if terminal_identity(identity["pid"], root) != identity:
            return "terminal identity changed"
        for entry in os.listdir(root):
            if not entry.isdigit() or int(entry) == identity["pid"]:
                continue
            try:
                p = proc_stat(int(entry), root)
                if p["state"] in ("Z", "X"):
                    continue
                if p["ttyNr"] == identity["ttyNr"] or p["ppid"] == identity["pid"]:
                    return "another process still uses the terminal"
            except (FileNotFoundError, ProcessLookupError):
                pass  # normal process disappearance; every other failure holds the tab
        return None
    except (OSError, ValueError, IndexError):
        return "could not verify terminal liveness"


def run(command):
    identity = terminal_identity(os.getpid())
    if identity is None:
        raise RuntimeError("managed terminals require a Linux PTY and readable /proc")
    libc = ctypes.CDLL(None, use_errno=True)
    # prctl is variadic: pass explicitly sized arguments (PR_SET_CHILD_SUBREAPER = 36).
    if libc.prctl(ctypes.c_int(36), ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        raise OSError(ctypes.get_errno(), "cannot enable terminal child subreaping")
    # End clears an agent draft with Ctrl-C. Only the agent should respond to that key.
    for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP):
        signal.signal(sig, lambda *_: None)
    child = subprocess.Popen(["/bin/bash", "-lc", "exec " + command])
    child.wait()  # actual exit; never agent idle, a stale PID, or a discovery guess
    reported = False
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid:
                continue  # reap an exited adopted descendant, then check again
            blocker = "a launched child process is still running"
        except ChildProcessError:
            blocker = terminal_exit_blocker(identity)
        if blocker is None:
            return
        if not reported:
            print(f"\r\nSwitchboard: agent exited; keeping this terminal: {blocker}.", flush=True)
            reported = True
        time.sleep(0.25)
    # No command reader remains. Keystrokes cannot start work between check and process exit.


if __name__ == "__main__":
    if len(sys.argv) != 3 or not re.fullmatch(r"[0-9a-f-]{36}", sys.argv[1]) or not sys.argv[2]:
        raise RuntimeError("invalid managed terminal launch")
    run(sys.argv[2])
