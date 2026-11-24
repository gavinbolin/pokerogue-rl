"""Launch and stop N headless sim server processes on their own TCP ports.

Ports 8765/8766 belong to Gavin's Play.bat server and are refused. Each server is
`node scripts/serve.mjs --no-http --tcp-port P`; its console goes to runs/_servers/serve-P.log.
Stopping sends {"cmd":"shutdown"} and then `taskkill /T /F` on the process tree as a fallback,
so no vitest child is left behind.
"""

from __future__ import annotations

import atexit
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import ROOT, RUNS
from .client import SimClient

RESERVED_PORTS = {8765, 8766}
DEFAULT_BASE_PORT = 8800


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _kill_tree(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
    else:
        try:
            os.killpg(pid, 9)
        except OSError:
            pass


class SimServer:
    def __init__(self, port: int, verbose: bool = False):
        if port in RESERVED_PORTS:
            raise ValueError(f"port {port} is reserved for the Play.bat server")
        if not port_free(port):
            raise RuntimeError(f"port {port} is already in use")
        self.port = port
        self.ready = threading.Event()
        self.exited = False
        logdir = RUNS / "_servers"
        logdir.mkdir(parents=True, exist_ok=True)
        self.log_path = logdir / f"serve-{port}.log"
        self._log = open(self.log_path, "w", encoding="utf-8", errors="replace")
        kw = {}
        if sys.platform == "win32":
            kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kw["start_new_session"] = True
        self.proc = subprocess.Popen(
            ["node", str(ROOT / "scripts" / "serve.mjs"), "--no-http", "--tcp-port", str(port)] + (["--verbose"] if verbose else []),
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            **kw,
        )
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            self._log.write(line + "\n")
            self._log.flush()
            if "[play] ready" in line:
                self.ready.set()
        self.exited = True
        self.ready.set()

    def wait_ready(self, timeout: float = 240.0) -> None:
        if not self.ready.wait(timeout) or self.exited:
            raise RuntimeError(f"sim server on port {self.port} did not start; see {self.log_path}")

    def stop(self, timeout: float = 15.0) -> None:
        if self.proc.poll() is None:
            try:
                c = SimClient(self.port, timeout=5)
                c.shutdown()
                c.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                pass
        if self.proc.poll() is None:
            _kill_tree(self.proc.pid)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                pass
        self._log.close()


class ServerPool:
    """Context manager: `with ServerPool(6) as pool: pool.ports` -> [8800, ..., 8805]."""

    def __init__(self, n: int, base_port: int = DEFAULT_BASE_PORT, verbose: bool = False, timeout: float = 300.0):
        self.n, self.base_port, self.verbose, self.timeout = n, base_port, verbose, timeout
        self.servers: list[SimServer] = []

    def start(self) -> "ServerPool":
        t0 = time.time()
        port = self.base_port
        try:
            while len(self.servers) < self.n:
                if port not in RESERVED_PORTS and port_free(port):
                    self.servers.append(SimServer(port, self.verbose))
                port += 1
            for s in self.servers:
                s.wait_ready(self.timeout)
        except BaseException:
            self.stop()
            raise
        atexit.register(self.stop)
        self.start_seconds = time.time() - t0
        return self

    @property
    def ports(self) -> list[int]:
        return [s.port for s in self.servers]

    def stop(self) -> None:
        threads = [threading.Thread(target=s.stop) for s in self.servers]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.servers = []

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()


def servers_or_ports(n: int, ports: str | None, base_port: int = DEFAULT_BASE_PORT):
    """Use already-running servers (`--ports 8800,8801`) or start n new ones. Returns (ports, pool|None)."""
    if ports:
        ps = [int(p) for p in ports.split(",") if p.strip()]
        bad = [p for p in ps if p in RESERVED_PORTS]
        if bad:
            raise SystemExit(f"refusing reserved Play.bat port(s) {bad}")
        return ps, None
    print(f"[servers] starting {n} sim servers from port {base_port} (cold start ~25-60 s)...", flush=True)
    pool = ServerPool(n, base_port).start()
    print(f"[servers] ready on {pool.ports} in {pool.start_seconds:.1f} s", flush=True)
    return pool.ports, pool


def main():
    """`python -m rl.servers --n 6` : start servers and keep them up until Ctrl+C (for --ports reuse)."""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--base-port", type=int, default=DEFAULT_BASE_PORT)
    a = ap.parse_args()
    ports, pool = servers_or_ports(a.n, None, a.base_port)
    print(f"[servers] use --ports {','.join(map(str, ports))}   (Ctrl+C stops them)", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        pool.stop()
        print("[servers] stopped")


if __name__ == "__main__":
    main()
