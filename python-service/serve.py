"""Start the renderer on a dual-stack (IPv6 + IPv4) socket.

Railway's private network resolves `*.railway.internal` to an IPv6 address in
legacy environments (created before 2025-10-16) and to both IPv4 and IPv6 in
newer ones. Meanwhile Railway's own health check and public edge reach the
container over IPv4.

`uvicorn --host 0.0.0.0` therefore refuses private-network connections on
legacy environments (the caller sees ECONNREFUSED), and `uvicorn --host ::`
does not help because uvicorn hands the host to asyncio, which sets
IPV6_V6ONLY on the socket and so drops IPv4 health checks.

This launcher binds the socket itself with IPV6_V6ONLY disabled and hands it to
uvicorn, so one listener serves IPv6 and IPv4 at the same time. If the kernel
has no usable IPv6 stack (some minimal container runtimes), it falls back to a
plain IPv4 socket.
"""

from __future__ import annotations

import os
import socket
import sys

import uvicorn


def listen_socket(port: int, backlog: int = 2048) -> socket.socket:
    """Return a listening socket, dual-stack when the kernel allows it."""
    if socket.has_ipv6:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            sock.bind(("::", port))
            sock.listen(backlog)
            sock.set_inheritable(True)
            print(f"Renderer listening on [::]:{port} (IPv6 + IPv4).", flush=True)
            return sock
        except OSError as error:
            sock.close()
            print(
                f"Dual-stack bind on [::]:{port} failed ({error}); falling back to IPv4 only.",
                file=sys.stderr,
                flush=True,
            )

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.listen(backlog)
    sock.set_inheritable(True)
    print(f"Renderer listening on 0.0.0.0:{port} (IPv4 only).", flush=True)
    return sock


def main() -> int:
    port = int(os.getenv("PORT", "8000"))
    sock = listen_socket(port)
    config = uvicorn.Config(
        "main:app",
        log_level=os.getenv("LOG_LEVEL", "info"),
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
    uvicorn.Server(config).run(sockets=[sock])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
