#!/usr/bin/env python3
"""
Servidor de desenvolvimento local — serve a pasta `site/` e aceita POST de
selfies de verificação em /api/save-selfie, gravando-as em
/Users/lk/Projects/fotos app pt/.

Em produção (Vercel), este script não é usado — as serverless functions em
api/*.js tratam dos endpoints. Vê api/save-selfie.js para o equivalente
serverless.
"""
import base64
import json
import os
import re
import sys
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.join(ROOT, "site")
PHOTOS_DIR = "/Users/lk/Projects/fotos app pt"
PORT = int(os.environ.get("PORT", "8765"))

os.makedirs(PHOTOS_DIR, exist_ok=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/save-selfie":
            self._send_json(404, {"ok": False, "error": "endpoint não encontrado"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 6 * 1024 * 1024:  # 6 MB máx
            self._send_json(413, {"ok": False, "error": "payload em falta ou demasiado grande"})
            return

        try:
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json(400, {"ok": False, "error": "JSON inválido"})
            return

        data_url = str(body.get("photo") or "")
        match = re.match(r"^data:image/(jpeg|jpg|png|webp);base64,(.+)$", data_url, re.IGNORECASE)
        if not match:
            self._send_json(400, {"ok": False, "error": "campo `photo` em falta ou formato inválido"})
            return

        ext = match.group(1).lower().replace("jpeg", "jpg")
        try:
            img_bytes = base64.b64decode(match.group(2), validate=True)
        except Exception:
            self._send_json(400, {"ok": False, "error": "base64 inválido"})
            return

        if len(img_bytes) < 200:  # filtro contra placeholders triviais
            self._send_json(400, {"ok": False, "error": "imagem demasiado pequena"})
            return

        nif = re.sub(r"\D+", "", str(body.get("nif") or ""))[:9] or "anon"
        nome = re.sub(r"[^a-zA-Z0-9_\-]", "", str(body.get("nome") or "")[:30]) or "sem-nome"
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{ts}_{nif}_{nome}.{ext}"
        path = os.path.join(PHOTOS_DIR, filename)

        try:
            with open(path, "wb") as f:
                f.write(img_bytes)
        except OSError as e:
            self._send_json(500, {"ok": False, "error": f"falha a gravar: {e}"})
            return

        # Metadata opcional ao lado da imagem
        meta = {
            "saved_at": datetime.now().isoformat(timespec="seconds"),
            "nome": str(body.get("nome") or ""),
            "nif": str(body.get("nif") or ""),
            "email": str(body.get("email") or ""),
            "phone": str(body.get("phone") or ""),
            "user_agent": self.headers.get("User-Agent") or "",
            "ip": self.client_address[0],
            "file": filename,
            "size_bytes": len(img_bytes),
        }
        try:
            with open(path + ".json", "w") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

        sys.stderr.write(f"[selfie] gravada {filename} ({len(img_bytes)} bytes)\n")
        self._send_json(200, {"ok": True, "file": filename})

    # Silenciar logs default (mantém só os nossos)
    def log_message(self, fmt, *args):
        return


def main():
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write(f"Servidor a correr em http://localhost:{PORT}\n")
    sys.stderr.write(f"Selfies vão para: {PHOTOS_DIR}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
