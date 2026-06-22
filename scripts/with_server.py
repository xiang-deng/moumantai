#!/usr/bin/env python3
"""Start one or more servers, wait for readiness, run a command, then shut down.

Usage:
  python scripts/with_server.py --server "npm run dev" --port 5174 -- python tests/e2e/test_app.py
  python scripts/with_server.py --server "node server.js" --port 3000 --server "npm run dev" --port 5174 -- python tests/e2e/test_app.py

Options:
  --server CMD   Command to start a server (repeatable)
  --port PORT    Port to wait for (one per --server)
  --timeout SEC  Max seconds to wait for readiness (default: 30)
"""

import argparse
import subprocess
import sys
import time
import socket
import signal
import os


def wait_for_port(port, timeout=30):
    """Wait until a port is accepting connections."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection(("localhost", port), timeout=1):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.5)
    return False


def main():
    parser = argparse.ArgumentParser(
        description="Start servers, run command, shut down"
    )
    parser.add_argument(
        "--server", action="append", required=True, help="Server command (repeatable)"
    )
    parser.add_argument(
        "--port",
        action="append",
        type=int,
        required=True,
        help="Port to wait for (one per server)",
    )
    parser.add_argument(
        "--timeout", type=int, default=30, help="Seconds to wait for readiness"
    )
    parser.add_argument(
        "command", nargs=argparse.REMAINDER, help="Command to run after servers ready"
    )
    args = parser.parse_args()

    if args.command and args.command[0] == "--":
        args.command = args.command[1:]

    if len(args.server) != len(args.port):
        print("Error: number of --server and --port flags must match", file=sys.stderr)
        sys.exit(1)

    if not args.command:
        print("Error: no command specified after --", file=sys.stderr)
        sys.exit(1)

    processes = []
    try:
        for cmd in args.server:
            print(f"Starting: {cmd}")
            proc = subprocess.Popen(
                cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid if hasattr(os, "setsid") else None,
            )
            processes.append(proc)

        for port in args.port:
            print(f"Waiting for port {port}...")
            if not wait_for_port(port, args.timeout):
                print(
                    f"Error: port {port} not ready after {args.timeout}s",
                    file=sys.stderr,
                )
                sys.exit(1)
            print(f"Port {port} ready")

        print(f"Running: {' '.join(args.command)}")
        result = subprocess.run(args.command)
        sys.exit(result.returncode)

    finally:
        for proc in processes:
            try:
                if hasattr(os, "killpg"):
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                else:
                    proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


if __name__ == "__main__":
    main()
