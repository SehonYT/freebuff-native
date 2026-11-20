#!/usr/bin/env python3
import argparse, errno, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time
p = argparse.ArgumentParser()
p.add_argument('--cwd', default=os.getcwd())
p.add_argument('--timeout', type=float, default=75)
p.add_argument('--output')
p.add_argument('--expect', default='4167')
p.add_argument('--prompt', default='Calculate 1789 plus 2378. Reply only with the resulting integer.')
p.add_argument('command', nargs='*')
a = p.parse_args()
cmd = a.command or [os.path.expanduser('~/.local/bin/freebuff'), '--cwd', a.cwd]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(a.cwd)
    os.environ['TERM'] = 'xterm-256color'
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
os.set_blocking(fd, False)
start = time.monotonic()
raw = bytearray()
replied = set()
typed = None
submitted = None
next_sample = start + 20
completed = False
status = None
def own_pids():
    result = []
    for s in os.listdir('/proc'):
        if s.isdigit():
            try:
                if os.getsid(int(s)) == pid: result.append(int(s))
            except (ProcessLookupError, PermissionError): pass
    return result
def rf(path):
    try:
        with open(path) as f: return f.read().strip()
    except OSError: return '?'
def sample():
    rows = []
    for n in own_pids():
        rows.append({'pid': n, 'cmd': rf('/proc/%d/cmdline' % n).replace('\x00', ' ')[:150], 'syscall': rf('/proc/%d/syscall' % n), 'wchan': rf('/proc/%d/wchan' % n)})
    print(json.dumps({'seconds': round(time.monotonic()-start, 1), 'processes': rows}), file=sys.stderr, flush=True)
try:
    while time.monotonic()-start < a.timeout:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: data = os.read(fd, 65536)
            except OSError as e:
                if e.errno == errno.EIO: break
                if e.errno == errno.EAGAIN: continue
                raise
            if not data: break
            raw.extend(data)
            tail = bytes(raw[-2048:])
            queries = [(b'\x1b]11;?', b'\x1b]11;rgb:2828/2828/2828\x1b\\'), (b'\x1b[c', b'\x1b[?62;22c'), (b'\x1b[6n', b'\x1b[1;1R')]
            for q, r in queries:
                if q in tail and q not in replied:
                    replied.add(q)
                    os.write(fd, r)
        now = time.monotonic()
        if typed is None and now-start > 12 and b'Enter a coding task' in raw:
            os.write(fd, a.prompt.encode())
            typed = now
            print('prompt typed', file=sys.stderr, flush=True)
        if typed is not None and submitted is None and now-typed > 0.4:
            os.write(fd, b'\r')
            submitted = now
            print('prompt submitted', file=sys.stderr, flush=True)
        if submitted is not None and a.expect.encode() in raw and now-submitted > 1:
            completed = True
            break
        if now >= next_sample:
            sample()
            next_sample = now + 20
        done, state = os.waitpid(pid, os.WNOHANG)
        if done:
            status = state
            break
    sample()
finally:
    for n in sorted(own_pids(), reverse=True):
        try: os.kill(n, signal.SIGTERM)
        except ProcessLookupError: pass
    end = time.monotonic() + 2
    while status is None and time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                extra = os.read(fd, 65536)
                if extra: raw.extend(extra)
            except OSError: pass
        try:
            done, state = os.waitpid(pid, os.WNOHANG)
            if done: status = state
        except ChildProcessError: break
    for n in own_pids():
        try: os.kill(n, signal.SIGKILL)
        except ProcessLookupError: pass
    if status is None:
        try: os.waitpid(pid, 0)
        except ChildProcessError: pass
    os.close(fd)
if a.output:
    with open(a.output, 'wb') as f: f.write(raw)
text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', raw.decode('utf8', 'replace'))
text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '\n', text)
print(json.dumps({'prompt_submitted': submitted is not None, 'completed': completed, 'bytes': len(raw), 'elapsed_seconds': round(time.monotonic()-start, 1)}))
print(text[-4500:])
sys.exit(0 if completed else 1)
