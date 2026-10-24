"""Serve the immutable original; inject declared test inputs only for ?parity=1."""
import argparse
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def inject_clock(html: bytes, clock: bytes) -> bytes:
    if b'<head>' not in html:
        raise ValueError('Original document has no head element')
    if b'</script' in clock.lower():
        raise ValueError('Clock script must not contain an HTML closing script tag')
    return html.replace(b'<head>', b'<head><script data-parity-input="seed-and-clock">' + clock + b'</script>', 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--clock', type=Path, required=True)
    parser.add_argument('--port', type=int, default=5179)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    original = (root / 'twin.html').read_bytes()
    clock = args.clock.read_bytes()

    class ReferenceHandler(SimpleHTTPRequestHandler):
        def __init__(self, *handler_args, **handler_kwargs):
            super().__init__(*handler_args, directory=str(root), **handler_kwargs)

        def do_GET(self):
            request = urlsplit(self.path)
            if request.path == '/twin.html' and parse_qs(request.query).get('parity') == ['1']:
                body = inject_clock(original, clock)
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            else:
                super().do_GET()

    print(f'Original SHA256 {hashlib.sha256(original).hexdigest()}', flush=True)
    print(f'Test input SHA256 {hashlib.sha256(clock).hexdigest()}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), ReferenceHandler).serve_forever()


if __name__ == '__main__':
    main()
