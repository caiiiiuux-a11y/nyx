"""Serve the old home's verified synthetic model until the parent closes stdin."""
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Thread


def main():
    source_path = Path(__file__).resolve().parents[3] / "iris-adrian-home-phase2/server/fixture.py"
    source = source_path.read_bytes().replace(b"\r\n", b"\n")
    # iris-adrian-home 58f71883d43ffdbd6639b8eda2a40c6f807f4c76, server/fixture.py
    if hashlib.sha256(source).hexdigest() != "b9ec3d52a683b349a866cc44a1883453eb00e2c296a4b93397568cecb117a63e":
        raise RuntimeError("Old home synthetic model version changed")
    fixture = {"__name__": "home_provider_fixture", "__file__": str(source_path)}
    exec(compile(source, str(source_path), "exec"), fixture)

    with ThreadingHTTPServer(("127.0.0.1", 0), fixture["FixtureHandler"]) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            print(json.dumps({"port": server.server_port, "apiKey": fixture["KEY"], "models": fixture["MODELS"]}), flush=True)
            sys.stdin.buffer.read()
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
