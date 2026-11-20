// Local CONNECT proxy for CLIs on Android: no /etc/resolv.conf exists, so
// direct DNS fails. Node resolves via Android getaddrinfo and tunnels TLS.
import net from "node:net"
import dns from "node:dns"

const PORT = Number(process.env.FREEBUFF_PROXY_PORT || process.env.AGY_PROXY_PORT || 8975)
dns.setDefaultResultOrder("ipv4first")

net.createServer((client) => {
  client.once("error", () => client.destroy())
  let buf = ""
  client.on("data", function onData(chunk) {
    buf += chunk.toString("latin1")
    const end = buf.indexOf("\r\n\r\n")
    if (end === -1) { if (buf.length > 16384) client.destroy(); return }
    client.removeListener("data", onData)
    const head = buf.slice(0, end)
    const rest = Buffer.from(buf.slice(end + 4), "latin1")
    const m = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]/.exec(head)
    if (!m) { client.end("HTTP/1.1 405 CONNECT only\r\n\r\n"); return }
    dns.lookup(m[1], { family: 4 }, (err, addr) => {
      if (err) { try { client.end("HTTP/1.1 502 DNS " + err.code + "\r\n\r\n") } catch {} return }
      const up = net.connect({ host: addr, port: Number(m[2]) }, () => {
        client.write("HTTP/1.1 200 Connected\r\n\r\n")
        if (rest.length) up.write(rest)
        up.pipe(client); client.pipe(up)
      })
      up.on("error", () => { try { client.end("HTTP/1.1 502 upstream\r\n\r\n") } catch {} })
      client.on("error", () => up.destroy())
    })
  })
}).listen(PORT, "127.0.0.1", () => console.log("freebuff-proxy 127.0.0.1:" + PORT))
