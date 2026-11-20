#!/usr/bin/env python
# Reproduce the after-prompt freeze: start the TUI in a pty, type a prompt,
# then sample the CLI process state, children, and proxy log.
import os, pty, select, sys, time, json

PROXY_LOG = os.path.expanduser("~/freebuff-native/proxy.log")
pid, fd = pty.fork()
if pid == 0:
    os.environ.setdefault("TERM", "xterm-256color")
    os.execv("/data/data/com.termux/files/usr/bin/bash", ["bash", "-c", "exec /data/data/com.termux/files/home/.local/bin/freebuff"])

buf = b""
replied = set()
start = time.time()

def readfile(p):
    try:
        with open(p) as fh: return fh.read().strip()
    except Exception: return "?"

def find_cli_pids():
    out = []
    for d in os.listdir("/proc"):
        if not d.isdigit(): continue
        try:
            with open("/proc/%s/cmdline" % d, "rb") as fh: cmd = fh.read().decode("latin1")
        except Exception: continue
        if "manicode/freebuff" in cmd and "bash" not in cmd:
            out.append(d)
    return out

def sample(label):
    lines = ["[%s] t=%.1fs" % (label, time.time() - start)]
    for p in find_cli_pids():
        kids = []
        try:
            for t in os.listdir("/proc/%s/task" % p):
                with open("/proc/%s/task/%s/children" % (p, t)) as fh: kids += fh.read().split()
        except Exception: pass
        kidinfo = []
        for k in kids[:4]:
            kidinfo.append(readfile("/proc/%s/cmdline" % k).replace("\x00", " ")[:60])
        lines.append("  cli[%s] syscall=%s wchan=%s threads=%s" % (p,
            readfile("/proc/%s/syscall" % p), readfile("/proc/%s/wchan" % p),
            len(os.listdir("/proc/%s/task" % p)) if os.path.isdir("/proc/%s/task" % p) else "?"))
        if kidinfo: lines.append("    children: " + " | ".join(kidinfo))
    try:
        with open(PROXY_LOG) as fh: plines = fh.read().strip().split("\n")
        lines.append("  proxy log (%d lines):" % len(plines))
        for l in plines[-8:]: lines.append("    " + l)
    except Exception: lines.append("  no proxy log")
    print("\n".join(lines), file=sys.stderr)

prompted = False
deadline = start + 75
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1.0)
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        buf += data
        if b"\x1b]11;?" in buf and "osc" not in replied:
            replied.add("osc"); os.write(fd, b"\x1b]11;rgb:2828/2828/2828\x1b\\")
        if b"\x1b[c" in buf and "da" not in replied:
            replied.add("da"); os.write(fd, b"\x1b[?62;22c")
        if b"\x1b[?u" in buf and "kk" not in replied:
            replied.add("kk"); os.write(fd, b"\x1b[?0u")
    if not prompted and time.time() - start > 12 and len(buf) > 2000:
        prompted = True
        os.write(fd, b"Reply with exactly: PROBE OK")
        time.sleep(0.5)
        os.write(fd, b"\r")
        print("[probe] prompt submitted at t=12s", file=sys.stderr)
        time.sleep(5)
        sample("after-prompt+5s")
        time.sleep(15)
        sample("after-prompt+20s")
        time.sleep(15)
        sample("after-prompt+35s")
        break

print("[probe] total captured: %d bytes" % len(buf), file=sys.stderr)
sys.stdout.buffer.write(buf[-6000:])
