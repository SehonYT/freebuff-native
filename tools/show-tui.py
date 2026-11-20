import re, sys
data = open(sys.argv[1], "rb").read()
t = re.sub(rb"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", b" ", data)
t = re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", t)
t = re.sub(rb"\x1b[()][A-Z0-9]", b"", t)
t = re.sub(rb"\x1b[=>]", b"", t)
t = t.decode("latin1")
lines = [l.rstrip() for l in t.split("\n") if l.strip()]
print("[bytes: %d]" % len(data))
print("\n".join(lines[:25]))
