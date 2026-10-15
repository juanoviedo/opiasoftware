"""Rota el access_token de Meta sin que el token pase por el chat.

Pide el token NUEVO oculto por consola, lo valida contra la API, actualiza
server/meta-config.json y revoca el token VIEJO (el que transito por chat)
via /oauth/revoke. Nunca imprime tokens ni secretos.

Uso (desde la raiz del repo):
  python marketing/plan-leads/tools/rotate_token.py
"""
import getpass
import hashlib
import hmac
import io
import json
import sys
import urllib.parse
import urllib.request

from meta_api import API, CONFIG_PATH, load_config

# Minimo para que meta_api.py funcione: crear/anunciar, leer la cuenta y
# obtener el access token de la pagina (formularios de leads).
SCOPES_REQUERIDOS = {
    "ads_management", "ads_read", "business_management",
    "pages_show_list", "pages_manage_ads", "pages_read_engagement",
}


def proof(secret, token):
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


def fetch_err(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return True, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, e.read().decode("utf-8", "ignore")[:300]


def get_err(path, params):
    return fetch_err(f"{API}/{path}?{urllib.parse.urlencode(params)}")


def main():
    cfg = load_config()
    viejo = cfg["access_token"]

    print("Rotacion del token de Meta. El token nuevo se pega oculto (no aparece en pantalla).")
    nuevo = getpass.getpass("Pega el token NUEVO y presiona Enter: ").strip()
    if not nuevo:
        print("ERROR: token vacio. Nada cambiado.")
        sys.exit(1)
    if nuevo == viejo:
        print("ERROR: es el mismo token que ya esta en la config. Nada cambiado.")
        sys.exit(1)

    # 1. Validar el token nuevo ANTES de tocar la config o revocar nada.
    ok, resp = get_err("me", {
        "fields": "id,name",
        "access_token": nuevo,
        "appsecret_proof": proof(cfg["app_secret"], nuevo),
    })
    if not ok:
        print("ERROR: el token nuevo no funciona. Nada cambiado; el viejo sigue vivo.")
        print(f"   {resp}")
        sys.exit(1)
    print(f"Token nuevo valido: {resp.get('name')} (id {resp.get('id')})")

    ok, dbg = get_err("debug_token", {
        "input_token": nuevo,
        "access_token": f"{cfg['app_id']}|{cfg['app_secret']}",
    })
    scopes = dbg.get("data", {}).get("scopes", []) if ok else []
    if scopes:
        print(f"Permisos del token nuevo: {', '.join(scopes)}")
        faltan = SCOPES_REQUERIDOS - set(scopes)
        if faltan:
            print(f"ERROR: al token nuevo le faltan permisos: {', '.join(sorted(faltan))}.")
            print("   Genera el token de nuevo marcando TODOS los permisos de la lista.")
            print("   Nada cambiado; el viejo sigue vivo.")
            sys.exit(1)
    else:
        print("ADVERTENCIA: no pude leer los permisos del token nuevo (sigo igualmente).")

    # 2. Guardar el token nuevo en la config.
    cfg["access_token"] = nuevo
    with io.open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("server/meta-config.json actualizado con el token nuevo.")

    # 3. Revocar el token viejo. El endpoint autentica con cualquier token
    # valido del mismo system user o con el app token, y responde igual
    # versionado y sin version: se prueban las combinaciones.
    revocado = False
    ultimo_error = "(sin respuesta)"
    for base in (API, "https://graph.facebook.com"):
        for tok in (nuevo, f"{cfg['app_id']}|{cfg['app_secret']}"):
            ok, resp = fetch_err(f"{base}/oauth/revoke?{urllib.parse.urlencode({
                'client_id': cfg['app_id'],
                'client_secret': cfg['app_secret'],
                'revoke_token': viejo,
                'access_token': tok,
            })}")
            if ok and resp.get("success"):
                revocado = True
                break
            if not ok:
                ultimo_error = resp
        if revocado:
            break

    if revocado:
        print("Token viejo revocado via /oauth/revoke.")
    else:
        # La config ya quedo con el token nuevo; sin este respaldo el viejo
        # seria irrecuperable y no se podria reintentar la revocacion.
        bak = CONFIG_PATH.replace("meta-config.json", "meta-config.old.json")
        with io.open(bak, "w", encoding="utf-8") as f:
            json.dump({"access_token": viejo}, f)
        print("ADVERTENCIA: no pude revocar el token viejo via API.")
        print(f"   Quedo respaldado en {bak} (gitignored). Avísale a la IA para revocarlo a mano.")

    # 4. Verificacion final: el viejo debe fallar, el nuevo ya funciono arriba.
    ok, resp = get_err("me", {
        "fields": "id",
        "access_token": viejo,
        "appsecret_proof": proof(cfg["app_secret"], viejo),
    })
    if ok:
        print("PROBLEMA: el token viejo TODAVIA responde. Reportalo a la IA.")
    else:
        print("Verificado: el token viejo ya no sirve.")

    print("\nListo. Para confirmar todo: python marketing/plan-leads/tools/meta_api.py --validate")


if __name__ == "__main__":
    main()
