#!/usr/bin/env python3
"""
Cliente de Meta Marketing API para subir la campaña de leads de OPIA.

Usa solo la libreria estandar (urllib) para no introducir dependencias.
Las credenciales viven en server/meta-config.json, que esta fuera de git.

Modos:
  --validate   Solo lectura: verifica token, cuenta, pagina, pixel e imagenes.
  --create     Crea la campaña completa (todo PAUSADO por defecto).
  --activate   Ademas de crear, activa campana y conjuntos (gasta dinero real).

Nunca imprime el access token.
"""

import argparse
import hashlib
import hmac
import io
import json
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CONFIG_PATH = os.path.join(ROOT, "server", "meta-config.json")

API = "https://graph.facebook.com/v25.0"
PIXEL_ID = "1096286453264873"
PAGE_USERNAME = "opiasoftware"

# Geografia del plan-leads: ciudad -> codigo de pais (para targeting).
CITY_TO_CC = {
    "ciudad de mexico": "MX", "bogota": "CO", "santiago": "CL",
    "buenos aires": "AR", "lima": "PE", "quito": "EC",
    "ciudad de panama": "PA", "san jose": "CR", "montevideo": "UY",
    "ciudad de guatemala": "GT", "san salvador": "SV", "santo domingo": "DO",
}

# Los 4 angulos de prospeccion de meta-ads-copys.csv. Un anuncio por angulo,
# todos dentro del mismo conjunto amplio: el filtrado lo hacen el anuncio y
# las preguntas del formulario, no una lista de intereses.
COPIES = [
    {
        "key": "dolor_excel",
        "message": "¿Sigues llevando pedidos, inventario o aprobaciones en Excel y WhatsApp? Te decimos qué conviene automatizar primero.",
        "name": "Diagnóstico gratuito de procesos",
        "description": "Plan escrito. Sin costo.",
        "link": "https://opiasoftware.com/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=dolor_excel",
    },
    {
        "key": "plan_concreto",
        "message": "Una pyme no necesita más herramientas: necesita que la información no se pierda. Revisamos tu proceso y te damos un plan.",
        "name": "Qué automatizar y qué no",
        "description": "Sesión gratis de 30 minutos.",
        "link": "https://opiasoftware.com/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=plan_concreto",
    },
    {
        "key": "pauta_sin_retorno",
        "message": "Si pagas pauta y no sabes cuántas consultas trajo, el problema no es el anuncio. Es la oferta, la página y el seguimiento.",
        "name": "Por qué tu pauta no trae leads",
        "description": "Lo revisamos contigo. Gratis.",
        "link": "https://opiasoftware.com/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=pauta_sin_retorno",
    },
    {
        "key": "licencia_ya_paga",
        "message": "Tu empresa ya paga Microsoft 365. Power Apps, Power Automate y Power BI están incluidos y casi nadie los usa bien.",
        "name": "Aprovecha tu Microsoft 365",
        "description": "Apps sin licencias nuevas.",
        "link": "https://opiasoftware.com/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=licencia_ya_paga",
    },
]

FORM_PRIVACY_URL = "https://opiasoftware.com/privacidad"
FORM_QUESTIONS = [
    {"type": "standard", "key": "full_name"},
    {"type": "standard", "key": "email"},
    {"type": "standard", "key": "phone_number"},
    {
        "type": "custom",
        "label": "¿Cuántas personas trabajan en tu empresa?",
        "options": [
            {"key": "solo_yo", "value": "Solo yo"},
            {"key": "2_10", "value": "2-10"},
            {"key": "11_50", "value": "11-50"},
            {"key": "51_200", "value": "51-200"},
            {"key": "mas_200", "value": "Más de 200"},
        ],
    },
    {"type": "custom", "label": "¿Qué proceso te gustaría resolver?"},
]

AD_SET_NAME = "PYME LatAm · Prospección"
CAMPAIGN_NAME = "PYME LatAm · Leads · OPIA 2026"
CAMPAIGN_PREFIX = "PYME LatAm"


class MetaError(Exception):
    pass


class Client:
    def __init__(self, cfg):
        self.app_id = cfg["app_id"]
        self.app_secret = cfg["app_secret"]
        self.token = cfg["access_token"]
        self.proof = hmac.new(
            self.app_secret.encode(), self.token.encode(), hashlib.sha256
        ).hexdigest()

    def _params(self, extra=None):
        p = {"access_token": self.token, "appsecret_proof": self.proof}
        if extra:
            p.update(extra)
        return p

    def get(self, path, fields=None, params=None):
        q = self._params(params)
        if fields:
            q["fields"] = fields if isinstance(fields, str) else ",".join(fields)
        url = f"{API}/{path.lstrip('/')}?{urllib.parse.urlencode(q)}"
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise MetaError(f"GET {path}: HTTP {e.code} {e.read().decode('utf-8', 'ignore')[:600]}")
        except Exception as e:
            raise MetaError(f"GET {path}: {e}")

    def post(self, path, data=None):
        body = urllib.parse.urlencode(self._params(data)).encode("utf-8")
        req = urllib.request.Request(f"{API}/{path.lstrip('/')}", data=body)
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise MetaError(f"POST {path}: HTTP {e.code} {e.read().decode('utf-8', 'ignore')[:900]}")
        except Exception as e:
            raise MetaError(f"POST {path}: {e}")


def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(f"ERROR: no existe {CONFIG_PATH}")
        print("  Copia server/meta-config.example.json y llena app_id, app_secret y access_token.")
        sys.exit(1)
    with io.open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def cmd_validate(cli, args):
    print("== 1. Token ==")
    me = cli.get("me", fields=["id", "name"])
    print(f"   Token valido. Usuario: {me.get('name')} (id {me.get('id')})")

    print("\n== 2. Cuentas publicitarias con acceso ==")
    accounts = cli.get("me/adaccounts", fields=["id", "name", "account_status", "currency", "timezone_name", "spend_cap", "balance"])
    data = accounts.get("data", [])
    if not data:
        print("   ERROR: el token no ve ninguna cuenta publicitaria.")
        print("   El token debe tener permiso ads_management sobre la cuenta.")
        return
    for a in data:
        estado = {1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE", 101: "CLOSED", 102: "LIMITED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED"}.get(a.get("account_status"), a.get("account_status"))
        print(f"   {a['id']:22} {a.get('name','')[:36]:38} estado={estado} moneda={a.get('currency')} zona={a.get('timezone_name')}")

    print("\n== 3. Paginas gestionadas ==")
    pages = cli.get("me/accounts", fields=["id", "name", "username"])
    for p in pages.get("data", []):
        marcar = "  <- objetivo" if (p.get("username") or "").lower() == PAGE_USERNAME else ""
        print(f"   {p['id']:20} {p.get('name','')[:30]:32} @{p.get('username','')}{marcar}")
    if not any((p.get("username") or "").lower() == PAGE_USERNAME for p in pages.get("data", [])):
        print(f"   ADVERTENCIA: no se encontro la pagina @{PAGE_USERNAME} entre las gestionadas.")

    print("\n== 4. Pixel ==")
    try:
        px = cli.get(PIXEL_ID, fields=["id", "name", "is_unavailable"])
        print(f"   Pixel {px.get('id')} ({px.get('name')})")
    except MetaError as e:
        print(f"   ERROR: no se pudo leer el pixel: {e}")

    acct = args.account or (data[0]["id"] if len(data) == 1 else None)
    if acct:
        print(f"\n== 5. Imagenes existentes en {acct} ==")
        imgs = cli.get(f"{acct}/adimages", fields=["hash", "name", "width", "height"], params={"limit": 100})
        for im in imgs.get("data", [])[:30]:
            print(f"   hash={im.get('hash')}  {im.get('width')}x{im.get('height')}  {im.get('name','')[:40]}")
        if not imgs.get("data"):
            print("   (sin imagenes subidas aun)")

        print(f"\n== 6. Campanas existentes en {acct} ==")
        camps = cli.get(f"{acct}/campaigns", fields=["id", "name", "objective", "status", "effective_status"])
        for c in camps.get("data", [])[:30]:
            print(f"   {c['id']:20} [{c.get('effective_status')}] {c.get('name','')[:50]}")
        if not camps.get("data"):
            print("   (sin campanas)")

    print("\nVALIDATE OK: credenciales y estructura resueltas.")


def _sin_acentos(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def resolve_cities(cli):
    """Devuelve [{'key','name','country_code'}] buscando cada ciudad en la API.

    Los 'key' de ciudad no son estables entre documentos: se resuelven en vivo
    contra /search y se filtran por pais, porque nombres como Santiago o San
    Jose existen en varios paises.
    """
    cities = []
    for ciudad, cc in CITY_TO_CC.items():
        found = None
        for q in (ciudad, _sin_acentos(ciudad)):
            r = cli.get("search", params={
                "type": "adgeolocation", "q": q,
                "location_types": "city", "limit": 25,
            })
            for loc in r.get("data", []):
                if loc.get("type") == "city" and loc.get("country_code") == cc:
                    found = {"key": loc["key"], "name": loc["name"], "country_code": cc}
                    break
            if found:
                break
        if not found:
            raise MetaError(f"No se pudo resolver la ciudad '{ciudad}' ({cc}) en el targeting de Meta.")
        cities.append(found)
    return cities


def create_lead_form(cli, page_id):
    """Formulario instantaneo con las 2 preguntas de calificacion del plan.

    El formulario se crea en la pagina (no en la cuenta). La URL de privacidad
    es obligatoria para Meta: por eso existia el bloqueo sin /privacidad.
    """
    r = cli.post(f"{page_id}/leadgen_forms", {
        "name": "Diagnóstico gratuito · OPIA (API)",
        "locale": "es_ES",
        "questions": json.dumps(FORM_QUESTIONS),
        "privacy_policy": json.dumps({"url": FORM_PRIVACY_URL}),
        "thank_you_screen": json.dumps({
            "title": "Solicitud recibida",
            "body": "Te contactaremos por WhatsApp o correo para agendar tu diagnóstico gratuito de 30 minutos.",
            "link_text": "Conocer OPIA Software",
            "link_url": "https://opiasoftware.com",
        }),
    })
    return r["id"]


def cmd_create(cli, args, activate=False):
    if not args.account:
        print("ERROR: --create/--activate necesita --account <act_...>. Corre --validate para ver tus cuentas.")
        sys.exit(1)
    if not args.page_id:
        print("ERROR: --create/--activate necesita --page-id <id>. Corre --validate para ver tus paginas.")
        sys.exit(1)

    acct_info = cli.get(args.account, fields=["id", "name", "currency", "account_status", "timezone_name"])
    moneda = acct_info.get("currency", "USD")
    budget = float(args.budget)
    print(f"Cuenta: {acct_info.get('name')} ({args.account})")
    print(f"Moneda de la cuenta: {moneda} · zona horaria: {acct_info.get('timezone_name')}")
    print(f"Presupuesto del conjunto: {budget:.2f} {moneda} total · {args.days} dias · Lun-Vie 10:00-20:00 ({moneda} de la cuenta, no USD fijo)")
    if moneda != "USD":
        print(f"ADVERTENCIA: el plan esta pensado en USD; {budget:.2f} se interpretara en {moneda}. Ajusta con --budget.")

    image_hash = args.image_hash
    if args.image_url:
        print("\n== Subiendo imagen desde URL ==")
        up = cli.post(f"{args.account}/adimages", {"url": args.image_url})
        imgs = up.get("images", {})
        image_hash = next(iter(imgs.values())).get("hash") if imgs else None
        print(f"   Imagen subida. hash={image_hash}")
    if not image_hash:
        print("ERROR: falta --image-hash o --image-url. Corre --validate para ver los hashes existentes.")
        sys.exit(1)

    print("\n== Resolviendo ciudades ==")
    cities = resolve_cities(cli)
    for c in cities:
        print(f"   {c['name']} ({c['country_code']}) key={c['key']}")

    print("\n== Creando campana ==")
    camp = cli.post(f"{args.account}/campaigns", {
        "name": CAMPAIGN_NAME,
        "objective": "OUTCOME_LEADS",
        "buying_type": "AUCTION",
        "special_ad_categories": json.dumps([]),
        "status": "PAUSED",
    })
    campaign_id = camp["id"]
    print(f"   campana {campaign_id} (PAUSADA)")

    # La franja horaria exige presupuesto total (lifetime), no diario.
    start = datetime.now(timezone.utc) + timedelta(minutes=20)
    end = start + timedelta(days=args.days)
    fmt = "%Y-%m-%dT%H:%M:%S%z"
    adset = cli.post(f"{args.account}/adsets", {
        "name": AD_SET_NAME,
        "campaign_id": campaign_id,
        "lifetime_budget": str(int(round(budget * 100))),
        "start_time": start.strftime(fmt),
        "end_time": end.strftime(fmt),
        "adset_schedule": json.dumps([{"start_minute": 600, "end_minute": 1200, "days": [1, 2, 3, 4, 5]}]),
        "optimization_goal": "LEAD_GENERATION",
        "billing_event": "IMPRESSIONS",
        "targeting": json.dumps({
            "age_min": 28,
            "age_max": 60,
            "geo_locations": {"cities": [{"key": c["key"]} for c in cities]},
        }),
        "promoted_object": json.dumps({"page_id": args.page_id}),
        "status": "PAUSED",
    })
    adset_id = adset["id"]
    print(f"   conjunto {adset_id} (PAUSADO) · {budget:.2f} {moneda} · {start.date()} -> {end.date()}")

    print("\n== Creando formulario instantaneo ==")
    form_id = create_lead_form(cli, args.page_id)
    print(f"   formulario {form_id} · privacidad: {FORM_PRIVACY_URL}")

    print("\n== Creando anuncios ==")
    ads = []
    for cp in COPIES:
        # object_id + object_type LEAD_GEN enlaza el formulario con el creativo;
        # sin object_id el anuncio no sabe que formulario abrir.
        creative = cli.post(f"{args.account}/adcreatives", {
            "name": f"OPIA · {cp['key']}",
            "object_id": form_id,
            "object_type": "LEAD_GEN",
            "object_story_spec": json.dumps({
                "page_id": args.page_id,
                "link_data": {
                    "message": cp["message"],
                    "name": cp["name"],
                    "description": cp["description"],
                    "link": cp["link"],
                    "image_hash": image_hash,
                    "call_to_action": {"type": "LEARN_MORE"},
                },
            }),
        })
        ad = cli.post(f"{args.account}/ads", {
            "name": f"OPIA · {cp['key']}",
            "adset_id": adset_id,
            "creative": json.dumps({"creative_id": creative["id"]}),
            "status": "PAUSED",
        })
        ads.append(ad["id"])
        print(f"   anuncio {ad['id']} [{cp['key']}] (PAUSADO)")

    print("\n== RESUMEN (todo PAUSADO, no gasta) ==")
    print(f"   campana:   {campaign_id}")
    print(f"   conjunto:  {adset_id}")
    print(f"   formulario:{form_id}")
    for aid in ads:
        print(f"   anuncio:   {aid}")
    print(f"\nRevisalo en el Administrador de anuncios. Si esta bien, activa con:")
    print(f"   python {os.path.basename(__file__)} --activate --account {args.account} --page-id {args.page_id} --image-hash {image_hash}")
    print("\nNOTA: el conjunto de retargeting NO se crea todavia: necesita que el Pixel")
    print("acumule trafico (el plan lo enciende con 500+ visitas). Se agrega despues.")

    if not activate:
        return

    print("\n== ACTIVANDO: esto empieza a gastar dinero real ==")
    cli.post(campaign_id, {"status": "ACTIVE"})
    cli.post(adset_id, {"status": "ACTIVE"})
    for aid in ads:
        cli.post(aid, {"status": "ACTIVE"})
    print(f"   campana {campaign_id} ACTIVA · conjunto ACTIVO · {len(ads)} anuncios ACTIVOS")
    print(f"   Entrega: Lun-Vie 10:00-20:00 hora de la cuenta ({acct_info.get('timezone_name')}), {budget:.2f} {moneda} total.")


def main():
    ap = argparse.ArgumentParser(description="Sube la campaña de leads de OPIA a Meta.")
    ap.add_argument("--validate", action="store_true", help="solo lectura, no crea nada")
    ap.add_argument("--create", action="store_true", help="crea la campaña (PAUSADA)")
    ap.add_argument("--activate", action="store_true", help="crea y ACTIVA (gasta dinero)")
    ap.add_argument("--account", help="ID de cuenta publicitaria, p.ej. act_1234567890")
    ap.add_argument("--page-id", help="ID de la pagina de Facebook")
    ap.add_argument("--image-hash", help="hash de la imagen a usar en los anuncios")
    ap.add_argument("--image-url", help="URL publica de la imagen (alternativa a --image-hash)")
    ap.add_argument("--budget", default="150.00", help="presupuesto TOTAL del conjunto en la moneda de la cuenta (default: 150.00)")
    ap.add_argument("--days", default=7, type=int, help="dias de duracion del presupuesto total (default: 7)")
    args = ap.parse_args()

    cfg = load_config()
    cli = Client(cfg)

    if args.validate or not (args.create or args.activate):
        cmd_validate(cli, args)
        return

    cmd_create(cli, args, activate=args.activate)


if __name__ == "__main__":
    main()
