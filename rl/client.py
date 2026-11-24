"""Client for the sim server's TCP JSON-lines API (see README "Server API")."""

from __future__ import annotations

import json
import socket
import time


class SimError(RuntimeError):
    pass


class SimClient:
    """One TCP connection to one sim server. Not thread-safe; use one client per thread/process."""

    def __init__(self, port: int, host: str = "127.0.0.1", timeout: float = 120.0, connect_retry_s: float = 0.0):
        deadline = time.time() + connect_retry_s
        while True:
            try:
                self.sock = socket.create_connection((host, port), timeout=timeout)
                break
            except OSError:
                if time.time() >= deadline:
                    raise
                time.sleep(0.5)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.port = port
        self._buf = b""
        self._id = 0

    def _readline(self) -> bytes:
        while True:
            i = self._buf.find(b"\n")
            if i >= 0:
                line, self._buf = self._buf[:i], self._buf[i + 1 :]
                return line
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise SimError(f"sim server on port {self.port} closed the connection")
            self._buf += chunk

    def call(self, cmd: str, **args) -> dict:
        self._id += 1
        msg = {"id": self._id, "cmd": cmd, **{k: v for k, v in args.items() if v is not None}}
        self.sock.sendall((json.dumps(msg) + "\n").encode())
        while True:
            r = json.loads(self._readline())
            if r.get("id") in (None, self._id):
                break
        if not r.get("ok"):
            raise SimError(f"{cmd}: {r.get('error')}")
        return r

    # convenience wrappers -------------------------------------------------
    def ping(self) -> dict:
        return self.call("ping")

    def reset(self, seed=None, team=None, max_waves=None, obs=True, log=False, policy="agent", out=None, visual=False) -> dict:
        """Start a run. Agent runs are unlogged by default (log=False), so nothing lands in runs/human."""
        return self.call(
            "reset",
            seed=None if seed is None else str(seed),
            team=team,
            maxWaves=max_waves,
            obs=obs,
            log=log,
            policy=policy,
            out=out,
            visual=visual,
        )

    def step(self, index: int, expect: str | None = None) -> dict:
        return self.call("step", index=int(index), expect=expect)

    def shutdown(self) -> None:
        try:
            self.call("shutdown")
        except (SimError, OSError, ValueError):
            pass

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass
