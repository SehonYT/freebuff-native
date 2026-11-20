#!/usr/bin/env python
# PTY probe for TUI CLIs: runs a command in a pty, answers common terminal
# queries, prints the process kernel state, and dumps captured output.
# Usage: python tui-probe.py [command arg...]   (default: the freebuff wrapper)
import os, pty, select, sys, time

cmd = sys.argv[1:] or ["bash", "-c", "exec $HOME/.local/bin/freebuff"]
pid, fd = pty.fork()
if pid == 0:
    os.environ.setdefault("TERM", "xterm-256color")
    os.execvp(cmd[0], cmd)

buf = b""
replied = set()
start = time.time()
sample_at = start + 12
sampled = False

def readfile(p):
    try:
        with open(p) as fh: return fh.read().strip()
    except Exception as e: return "ERR " + str(e)

def procinfo():
    out = "main[%d] " % pid
    out += "syscall=" + readfile("/proc/%d/syscall" % pid) + " "

    out += "wchan=" + readfile("/proc/%d/wchan" % pid) + " "

    out += "children(proc view)="

    sc = readfile("/proc/%d/syscall" % pid).split()
    if sc and sc[0] in ("260", "114") and sc[1] != "0xffffffff":
        k = str(int(sc[1], 16))
        out += "[" + k + "] cmd=" + readfile("/proc/%s/cmdline" % k).replace("\x00", " ")[:100] + " "

        out += "state=" + readfile("/proc/%s/status" % k).split("\n")[0] + " "

        out += "syscall=" + readfile("/proc/%s/syscall" % k) + " wchan=" + readfile("/proc/%s/wchan" % k)
    return out

deadline = start + 45
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1.0)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        buf += data
        if b"\x1b]11;?" in buf and "osc" not in replied and not os.environ.get("PROBE_NO_REPLY"):
            replied.add("osc")
            os.write(fd, b"\x1b]11;rgb:2828/2828/2828\x1b\\")
            print("[responder] replied OSC11", file=sys.stderr)
        if b"\x1b[c" in buf and "da" not in replied:
            replied.add("da"); os.write(fd, b"\x1b[?62;22c")
        if b"\x1b[?u" in buf and "kk" not in replied:
            replied.add("kk"); os.write(fd, b"\x1b[?0u")
    if not sampled and time.time() >= sample_at:
        sampled = True
        print("[sample @12s] " + procinfo(), file=sys.stderr)
        print("[bytes so far: %d]" % len(buf), file=sys.stderr)
    if len(buf) > 8000:
        time.sleep(2)
        break

print("[final] " + procinfo(), file=sys.stderr)
print("[total: %d bytes, queries answered: %s, elapsed: %.1fs]" % (len(buf), ",".join(sorted(replied)), time.time() - start), file=sys.stderr)
sys.stdout.buffer.write(buf[-4000:])
