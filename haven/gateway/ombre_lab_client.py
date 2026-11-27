"""Use the old home's pinned OAuth and MCP clients with the synthetic provider."""
import hashlib
from html.parser import HTMLParser
from http.client import HTTPSConnection
import json
import os
from pathlib import Path
import secrets
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory
from urllib.parse import parse_qs, urlencode, urlsplit


# iris-adrian-home, phase2/immersive-home, 58f71883d43ffdbd6639b8eda2a40c6f807f4c76.
CLIENTS = {
    "capability_client.py": "e48270de5d1a5237f40781b831bca304c7736670a37f35accfd8639d551f9009",
    "memory_oauth_client.py": "fee51b047e90f83bad89ed33d2b8a8641d452c116cb21ae9c24ae2e01e1b9c50",
}
CALLBACK = "http://127.0.0.1:17661/api/tools/memory/callback"


class ConsentForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = {}

    def handle_starttag(self, tag, attrs):
        field = dict(attrs)
        if tag == "input" and field.get("type") == "hidden":
            self.fields[field["name"]] = field.get("value", "")


def consent(port, url, form=None):
    target = urlsplit(url)
    if target.scheme != "https" or target.netloc != f"127.0.0.1:{port}":
        raise ValueError("Unexpected consent origin")
    socket = HTTPSConnection("127.0.0.1", port, timeout=5)
    try:
        path = target.path + ("?" + target.query if target.query else "")
        if form is None:
            socket.request("GET", path)
        else:
            socket.request("POST", path, urlencode(form), {"Content-Type": "application/x-www-form-urlencoded"})
        response = socket.getresponse()
        if response.status != (200 if form is None else 302):
            raise ValueError("Consent rejected")
        return response.read(65536).decode() if form is None else response.getheader("Location")
    finally:
        socket.close()


def call_lab(payload):
    from capability_client import call_tool
    from memory_oauth_client import MemoryOAuthClient, new_verifier

    tls_dir = Path("/lab-tls")
    os.environ["SSL_CERT_FILE"] = str(tls_dir / "mcp.pem")
    port = 18662
    resource = f"https://127.0.0.1:{port}/mcp"
    oauth = MemoryOAuthClient(resource, CALLBACK)
    metadata = oauth.discover()
    # This ID is public. The test password and the short-lived token stay in this process.
    registration = tls_dir / "haven-lab-client-id"
    saved_id = registration.read_text() if registration.is_file() else None
    client_id = saved_id or oauth.register(metadata)
    state, verifier = secrets.token_urlsafe(), new_verifier()
    url = oauth.authorization_url(metadata, client_id, state, verifier)
    form = ConsentForm()
    form.feed(consent(port, url))
    if form.fields.get("state") != state:
        raise ValueError("Invalid consent session")
    form.fields["password"] = (tls_dir / "provider-password").read_text()
    redirect = urlsplit(consent(port, metadata.authorization_endpoint, form.fields))
    fields = parse_qs(redirect.query)
    if redirect._replace(query="", fragment="").geturl() != CALLBACK or fields.get("state") != [state]:
        raise ValueError("Invalid lab callback")
    token = oauth.exchange(metadata, client_id, fields["code"][0], verifier)
    if client_id != saved_id:
        # An interrupted first consent must never leave an expired pending client on disk.
        with NamedTemporaryFile("w", dir=tls_dir, prefix="haven-client-", delete=False) as temp:
            temp.write(client_id)
        os.replace(temp.name, registration)
    result = call_tool(resource, token.access_token, payload["name"], payload["arguments"])
    text = result.get("structuredContent", {}).get("result")
    if not isinstance(text, str):
        text = "\n".join(block["text"] for block in result.get("content", [])
                         if block.get("type") == "text" and isinstance(block.get("text"), str))
    if not text.strip():
        raise ValueError("Empty tool response")
    return {"text": text}


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        with TemporaryDirectory() as folder:
            for filename, digest in CLIENTS.items():
                source = payload["clients"][filename].replace("\r\n", "\n").encode()
                if hashlib.sha256(source).hexdigest() != digest:
                    raise ValueError("Old home client version changed")
                (Path(folder) / filename).write_bytes(source)
            sys.path.insert(0, folder)
            result = call_lab(payload)
        print(json.dumps(result, ensure_ascii=True))
    except Exception:
        sys.exit("Synthetic Ombre operation failed")
