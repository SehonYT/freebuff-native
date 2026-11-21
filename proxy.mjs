// Local forward & CONNECT proxy for CLIs on Android: no /etc/resolv.conf exists,
// so direct DNS in glibc fails. Node resolves via Android getaddrinfo and tunnels.
import net from "node:net";
import dns from "node:dns";

const PORT = Number(process.env.FREEBUFF_PROXY_PORT || process.env.AGY_PROXY_PORT || 8975);
dns.setDefaultResultOrder("ipv4first");

const server = net.createServer((client) => {
  client.once("error", () => client.destroy());
  let buf = "";

  client.on("data", function onData(chunk) {
    buf += chunk.toString("latin1");
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buf.length > 32768) client.destroy();
      return;
    }
    client.removeListener("data", onData);

    const head = buf.slice(0, end);
    const rest = Buffer.from(buf.slice(end + 4), "latin1");
    const lines = head.split("\r\n");
    const firstLine = lines[0];

    // Case 1: HTTPS tunneling via CONNECT
    const connectMatch = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]/i.exec(firstLine);
    if (connectMatch) {
      const host = connectMatch[1];
      const port = Number(connectMatch[2]);
      dns.lookup(host, { family: 4 }, (err, addr) => {
        if (err) {
          try { client.end("HTTP/1.1 502 DNS " + err.code + "\r\n\r\n"); } catch {}
          return;
        }
        const up = net.connect({ host: addr, port }, () => {
          client.write("HTTP/1.1 200 Connected\r\n\r\n");
          if (rest.length) up.write(rest);
          up.pipe(client);
          client.pipe(up);
        });
        up.on("error", () => { try { client.end("HTTP/1.1 502 upstream\r\n\r\n"); } catch {} });
        client.on("error", () => up.destroy());
      });
      return;
    }

    // Case 2: Plain HTTP proxying (GET/POST/HEAD http://host:port/path ...)
    const httpMatch = /^([A-Z]+)\s+(?:https?:\/\/([^\/\s:]+)(?::(\d+))?)?(\S*)\s+HTTP\/1\.[01]/i.exec(firstLine);
    if (httpMatch) {
      let host = httpMatch[2];
      let port = httpMatch[3] ? Number(httpMatch[3]) : 80;
      let path = httpMatch[4] || "/";

      if (!host) {
        // Fall back to Host: header
        for (const line of lines) {
          const hMatch = /^Host:\s*([^:\s]+)(?::(\d+))?/i.exec(line);
          if (hMatch) {
            host = hMatch[1];
            if (hMatch[2]) port = Number(hMatch[2]);
            break;
          }
        }
      }

      if (!host) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }

      // Reconstruct clean HTTP request line
      const newHead = [firstLine.replace(/^([A-Z]+)\s+\S+/, "$1 " + path), ...lines.slice(1)].join("\r\n");
      const forwardBuf = Buffer.concat([Buffer.from(newHead + "\r\n\r\n", "latin1"), rest]);

      dns.lookup(host, { family: 4 }, (err, addr) => {
        if (err) {
          try { client.end("HTTP/1.1 502 DNS " + err.code + "\r\n\r\n"); } catch {}
          return;
        }
        const up = net.connect({ host: addr, port }, () => {
          up.write(forwardBuf);
          up.pipe(client);
          client.pipe(up);
        });
        up.on("error", () => { try { client.end("HTTP/1.1 502 upstream\r\n\r\n"); } catch {} });
        client.on("error", () => up.destroy());
      });
      return;
    }

    client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("freebuff-proxy 127.0.0.1:" + PORT);
});
