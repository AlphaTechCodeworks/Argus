#!/usr/bin/env python3
"""Tiny TCP helpers for the VPN site simulation (site-sim.sh); standard library only.

  simnet.py serve NAME PORT [PORT...]   listen on every port; each client gets one line:
                                        "<NAME> port <P> peer <client ip> mss <mss>" then close
  simnet.py probe HOST PORT [TIMEOUT]   connect, print "OPEN <line> clientmss <mss>" or
                                        TIMEOUT / REFUSED / ERROR <text>; exit 0/1/2/3
"""
import socket
import sys
import threading


def serve(name, ports):
    def run(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
        s.listen(16)
        while True:
            c, addr = s.accept()
            try:
                mss = c.getsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG)
                line = f"{name} port {port} peer {addr[0]} mss {mss}"
                print(line, flush=True)
                c.sendall((line + "\n").encode())
            finally:
                c.close()

    threads = [threading.Thread(target=run, args=(int(p),), daemon=True) for p in ports]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def probe(host, port, timeout):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        mss = s.getsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG)
        data = s.recv(200).decode(errors="replace").strip()
        print(f"OPEN {data} clientmss {mss}")
        return 0
    except socket.timeout:
        print("TIMEOUT")
        return 1
    except ConnectionRefusedError:
        print("REFUSED")
        return 2
    except OSError as e:
        print(f"ERROR {e.strerror or e}")
        return 3
    finally:
        s.close()


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "serve":
        serve(sys.argv[2], sys.argv[3:])
    elif len(sys.argv) >= 4 and sys.argv[1] == "probe":
        sys.exit(probe(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]) if len(sys.argv) > 4 else 3.0))
    else:
        print(__doc__)
        sys.exit(2)
