#!/usr/bin/env python3
"""Met à jour la politique de sécurité (Content-Security-Policy) de docs/index.html.

Le navigateur n'exécute que le script de la page dont l'empreinte (hash) est inscrite
dans la politique : un script ajouté par un pirate serait refusé.
À relancer après CHAQUE modification du <script> de docs/index.html :

    python3 scripts/securite_csp.py
"""
import base64, hashlib, pathlib, re

PAGE = pathlib.Path(__file__).resolve().parent.parent / "docs" / "index.html"
SUPABASE = "https://ybbxrlwshpaerinkowan.supabase.co"
SITE = "https://oasisofstyle86-jpg.github.io"
SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"

html = PAGE.read_text(encoding="utf-8")
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
if len(scripts) != 1:
    raise SystemExit(f"Attendu 1 script dans la page, trouvé {len(scripts)}")
digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode()

policy = "; ".join([
    "default-src 'none'",
    f"script-src 'sha256-{digest}' {SUPABASE_JS}",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    f"img-src 'self' data: {SITE} {SUPABASE}",
    f"connect-src {SUPABASE} {SUPABASE.replace('https://', 'wss://')}",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
])
meta = f'<meta http-equiv="Content-Security-Policy" content="{policy}">'
referrer = '<meta name="referrer" content="strict-origin-when-cross-origin">'

html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>\n?', "", html)
html = re.sub(r'<meta name="referrer"[^>]*>\n?', "", html)
html = html.replace('<meta charset="utf-8">\n', f'<meta charset="utf-8">\n{meta}\n{referrer}\n', 1)
PAGE.write_text(html, encoding="utf-8")
print("Politique de sécurité mise à jour :", digest)
