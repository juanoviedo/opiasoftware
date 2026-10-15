#!/usr/bin/env python3
"""
Genera los archivos de importación de Google Ads y Meta a partir del contenido
definido abajo. Valida los límites de caracteres antes de escribir, porque
Google rechaza en silencio lo que se pasa y eso cuesta días de campaña parada.

Uso: python3 marketing/plan-leads/tools/build_ads.py
"""

import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)

GOOGLE_HEADLINE_MAX = 30
GOOGLE_DESC_MAX = 90
META_PRIMARY_MAX = 125
META_HEADLINE_MAX = 40
META_DESC_MAX = 30

errors = []


def check(kind, text, limit, where):
    n = len(text)
    if n > limit:
        errors.append(f"{where}: {kind} de {n} chars (máx {limit}) -> {text!r}")
    return n


# --------------------------------------------------------------------------
# Oferta común. Se repite en todos los grupos a propósito: en búsqueda, el
# anuncio que nombra la oferta concreta gana CTR sobre el que solo describe.
# --------------------------------------------------------------------------
OFERTA = [
    "Diagnóstico Gratuito",
    "Sin Costo ni Compromiso",
    "Plan Escrito en 30 Min",
    "Respondemos en 1 Día Hábil",
    "OPIA Software",
]

CAMPAIGNS = {
    # --------------------------------------------------------- CAMPAÑA 1
    "Búsqueda · Software y Automatización · LatAm": {
        "budget": 15.0,
        "status": "Enabled",
        "ad_groups": {
            "Software a la medida": {
                "keywords": [
                    ("software a la medida", "Phrase"),
                    ("desarrollo de software empresarial", "Phrase"),
                    ("empresa de desarrollo de software", "Phrase"),
                    ("software personalizado para empresas", "Phrase"),
                    ("desarrollo aplicaciones empresariales", "Phrase"),
                    ("software para pymes", "Phrase"),
                    ("[software a la medida]", "Exact"),
                    ("[desarrollo software empresarial]", "Exact"),
                    ("[empresa desarrollo software]", "Exact"),
                    ("sistema de gestion para mi empresa", "Phrase"),
                    ("software para gestionar pedidos", "Phrase"),
                    ("software para inventarios empresa", "Phrase"),
                ],
                "headlines": [
                    "Software a la Medida",
                    "Desarrollo Software Empresa",
                    "Apps para tu Operación",
                    "Software para Pymes",
                    "Deja de Usar Excel Manual",
                    "Pedidos, Inventario y CRM",
                    "CRM y Facturación a tu Medida",
                    "Equipo en Colombia",
                    "Integra tu Microsoft 365",
                    "Entregas Revisables",
                ],
                "descriptions": [
                    "Procesos en Excel y correo convertidos en una app clara, con seguimiento real.",
                    "Agenda una sesión de 30 minutos. Te decimos qué automatizar y qué no. Sin costo.",
                    "Aplicaciones para ventas, inventarios, facturación y procesos propios de tu empresa.",
                    "Automatización con IA, Power Platform y software a la medida para pymes de LatAm.",
                ],
                "paths": ["software", "a-la-medida"],
            },
            "Automatización de procesos": {
                "keywords": [
                    ("automatizar procesos empresa", "Phrase"),
                    ("automatizacion de procesos de negocio", "Phrase"),
                    ("automatizar tareas repetitivas", "Phrase"),
                    ("automatizar excel", "Phrase"),
                    ("software de automatizacion", "Phrase"),
                    ("[automatizar procesos empresa]", "Exact"),
                    ("[automatizacion procesos negocio]", "Exact"),
                    ("automatizar aprobaciones", "Phrase"),
                    ("automatizar flujos de trabajo", "Phrase"),
                    ("bpm software empresa", "Phrase"),
                    ("reducir trabajo manual empresa", "Phrase"),
                ],
                "headlines": [
                    "Automatiza tus Procesos",
                    "Menos Excel, Más Trazabilidad",
                    "Automatización de Negocio",
                    "Aprueba y Registra sin Correo",
                    "Automatiza Tareas Repetitivas",
                    "Procesos con Estados Claros",
                    "Integra tus Herramientas",
                    "Diagnóstico del Proceso Gratis",
                    "IA Aplicada a tu Operación",
                    "Resultados Medibles",
                ],
                "descriptions": [
                    "Identificamos qué tarea te consume tiempo y la automatizamos. Diagnóstico gratuito.",
                    "Aprobaciones, pedidos e informes con responsables, estados y datos disponibles.",
                    "Revisamos tu proceso antes de proponer tecnología. A veces la solución no es software.",
                    "30 minutos y sales con un plan escrito de qué automatizar primero. Sin costo.",
                ],
                "paths": ["automatizacion", "procesos"],
            },
            "IA para empresas": {
                "keywords": [
                    ("inteligencia artificial para empresas", "Phrase"),
                    ("consultora inteligencia artificial", "Phrase"),
                    ("automatizacion con ia", "Phrase"),
                    ("ia para pymes", "Phrase"),
                    ("[inteligencia artificial empresas]", "Exact"),
                    ("asistente ia para empresas", "Phrase"),
                    ("extraer datos de documentos ia", "Phrase"),
                    ("chatbot empresarial con ia", "Phrase"),
                    ("implementar ia en mi empresa", "Phrase"),
                ],
                "headlines": [
                    "IA para tu Empresa",
                    "Automatización con IA",
                    "Extrae Datos de Documentos",
                    "Clasifica Solicitudes con IA",
                    "Asistentes con tu Conocimiento",
                    "IA Conectada a tus Procesos",
                    "Revisión Humana Siempre",
                    "Sin Promesas de Moda",
                    "Piloto con Alcance Concreto",
                    "Diagnóstico IA Gratuito",
                ],
                "descriptions": [
                    "Definimos un alcance concreto, probamos con tus datos y revisamos calidad antes.",
                    "La IA extrae, clasifica y resume; tu equipo conserva el criterio y la decisión.",
                    "Conectamos asistentes con tus documentos para responder con contexto real.",
                    "Sesión gratuita de 30 minutos para saber si la IA aplica a tu caso. Sin costo.",
                ],
                "paths": ["inteligencia", "artificial"],
            },
        },
    },
    # --------------------------------------------------------- CAMPAÑA 2
    "Búsqueda · Power Platform · LatAm": {
        "budget": 10.0,
        "status": "Enabled",
        "ad_groups": {
            "Power Apps y Power Automate": {
                "keywords": [
                    ("power apps consultora", "Phrase"),
                    ("consultor power apps", "Phrase"),
                    ("power automate consultoria", "Phrase"),
                    ("desarrollo power apps", "Phrase"),
                    ("[power apps consultora]", "Exact"),
                    ("[power automate consultoria]", "Exact"),
                    ("microsoft power platform partner", "Phrase"),
                    ("implementar power platform", "Phrase"),
                    ("app en power apps para empresa", "Phrase"),
                    ("automatizar con power automate", "Phrase"),
                ],
                "headlines": [
                    "Consultora Power Platform",
                    "Power Apps a la Medida",
                    "Power Automate para Empresas",
                    "Aprovecha tu Microsoft 365",
                    "Apps sin Licencias Nuevas",
                    "Integra SharePoint y Teams",
                    "Desarrollo en Power Apps",
                    "Flujos en Power Automate",
                    "Equipo Certificado",
                    "Diagnóstico Gratuito",
                ],
                "descriptions": [
                    "Construimos sobre el Microsoft 365 que tu empresa ya paga. Sin licencias nuevas.",
                    "Apps y flujos en Power Platform integrados con SharePoint, Teams y Dataverse.",
                    "Sesión gratuita de 30 minutos para definir si Power Platform te conviene.",
                    "Revisamos tu proceso antes de abrir la herramienta. Plan escrito y sin costo.",
                ],
                "paths": ["power", "platform"],
            },
            "Power BI": {
                "keywords": [
                    ("power bi consultor", "Phrase"),
                    ("consultoria power bi", "Phrase"),
                    ("tableros power bi", "Phrase"),
                    ("dashboards power bi empresa", "Phrase"),
                    ("[consultoria power bi]", "Exact"),
                    ("implementar power bi", "Phrase"),
                    ("reportes gerenciales power bi", "Phrase"),
                    ("power bi para pymes", "Phrase"),
                ],
                "headlines": [
                    "Consultoría Power BI",
                    "Tableros que Sí Se Usan",
                    "Dashboards para Gerencia",
                    "Power BI para Pymes",
                    "Datos Conectados y Confiables",
                    "De Excel a Decisiones Claras",
                    "Reportes Automáticos",
                    "Modelado de Datos Correcto",
                    "Capacitación a tu Equipo",
                    "Diagnóstico Gratuito",
                ],
                "descriptions": [
                    "Tableros diseñados alrededor de las preguntas reales de tu negocio, no de moda.",
                    "Conectamos tus fuentes, modelamos los datos y dejamos el tablero mantenido.",
                    "Sesión gratuita de 30 minutos: revisamos qué deberías estar midiendo.",
                    "Power BI sobre tu Microsoft 365. Plan escrito y sin compromiso.",
                ],
                "paths": ["power", "bi"],
            },
        },
    },
    # --------------------------------------------------------- CAMPAÑA 3
    "Búsqueda · Marketing y Publicidad · LatAm": {
        "budget": 15.0,
        "status": "Paused",
        "ad_groups": {
            "Publicidad digital B2B": {
                "keywords": [
                    ("agencia de publicidad digital", "Phrase"),
                    ("agencia google ads", "Phrase"),
                    ("manejo de google ads", "Phrase"),
                    ("agencia marketing b2b", "Phrase"),
                    ("[agencia google ads]", "Exact"),
                    ("[agencia marketing b2b]", "Exact"),
                    ("generacion de leads b2b", "Phrase"),
                    ("campañas para empresas servicios", "Phrase"),
                    ("consultor google ads", "Phrase"),
                ],
                "headlines": [
                    "Publicidad que Trae Consultas",
                    "Agencia de Marketing B2B",
                    "Gestión de Google Ads",
                    "Generación de Leads Real",
                    "No Más Clics sin Retorno",
                    "Oferta, Página y Seguimiento",
                    "Medición de Cada Campaña",
                    "Para Empresas de Servicios",
                    "Diagnóstico de tu Pauta Gratis",
                    "Equipo en Colombia",
                ],
                "descriptions": [
                    "Revisamos tu oferta, tu página y tu seguimiento, no solo los anuncios. Gratis.",
                    "Si inviertes en pauta y no sabes qué consultas llegan, el problema es medible.",
                    "Campañas conectadas a una acción comercial concreta y a un tablero de resultados.",
                    "Sesión de 30 minutos con un plan escrito. Sin costo y sin compromiso.",
                ],
                "paths": ["publicidad", "digital"],
            },
            "Landing pages y sitios web": {
                "keywords": [
                    ("diseño landing page", "Phrase"),
                    ("landing page para campaña", "Phrase"),
                    ("pagina web para empresa", "Phrase"),
                    ("[diseño landing page]", "Exact"),
                    ("crear landing page que convierta", "Phrase"),
                    ("pagina de ventas profesional", "Phrase"),
                    ("desarrollo web empresarial", "Phrase"),
                ],
                "headlines": [
                    "Landing Pages que Convierten",
                    "Página Web para Empresas",
                    "Una Sola Acción Clara",
                    "Diseñada para tu Campaña",
                    "Rápida y Medible",
                    "Con Formulario y Seguimiento",
                    "Optimizada para Móvil",
                    "Lista en Días, no Meses",
                    "Diagnóstico Gratuito",
                    "OPIA Software",
                ],
                "descriptions": [
                    "Una página por campaña, con un solo siguiente paso y medición real de leads.",
                    "Landing rápida, móvil y conectada a tu seguimiento comercial. Lista en días.",
                    "Si tu anuncio trae clics y no consultas, suele fallar la página. La revisamos.",
                    "Sesión gratuita de 30 minutos y un plan escrito. Sin costo ni compromiso.",
                ],
                "paths": ["landing", "pages"],
            },
        },
    },
}

# --------------------------------------------------------------------------
# Geolocalización por campaña. Formato "Ciudad, País" para que Google Ads no
# confunda homónimos ("Santiago" solo también resuelve a Santiago de
# Compostela). Caracas queda fuera a propósito: los métodos de pago de Google
# Ads en Venezuela fallan y la entrega se cae a cero.
# --------------------------------------------------------------------------
TIER1 = [
    "Ciudad de México, México",
    "Bogotá, Colombia",
    "Santiago, Chile",
    "Buenos Aires, Argentina",
    "Lima, Perú",
]

TIER2 = [
    "Quito, Ecuador",
    "Ciudad de Panamá, Panamá",
    "San José, Costa Rica",
    "Montevideo, Uruguay",
    "Ciudad de Guatemala, Guatemala",
    "San Salvador, El Salvador",
    "Santo Domingo, República Dominicana",
]

UBICACIONES = {
    # El mayor presupuesto va a donde hay más volumen de búsqueda B2B.
    "Búsqueda · Software y Automatización · LatAm": TIER1 + TIER2,
    # Power Platform solo rinde donde la penetración de Microsoft 365 es alta.
    "Búsqueda · Power Platform · LatAm": [
        "Ciudad de México, México",
        "Bogotá, Colombia",
        "Santiago, Chile",
        "Buenos Aires, Argentina",
        "Lima, Perú",
        "Quito, Ecuador",
        "Ciudad de Panamá, Panamá",
    ],
    # CPL de agencia es más alto: se limita a tier 1 para no diluir el gasto.
    "Búsqueda · Marketing y Publicidad · LatAm": TIER1,
}

# 10:00 a 20:00 hora local de la cuenta, lunes a viernes. Ver el problema del
# desfase entre países en 02-google-ads.md: la hora del anuncio se aplica en la
# zona horaria de la cuenta, no en la del país objetivo.
HORARIO = [("Lunes", "10:00", "20:00"), ("Martes", "10:00", "20:00"),
           ("Miércoles", "10:00", "20:00"), ("Jueves", "10:00", "20:00"),
           ("Viernes", "10:00", "20:00")]

# --------------------------------------------------------------------------
# Negativas a nivel de campaña. Filtran INTENCIÓN, nunca industria.
#
# Está a propósito la ausencia de "seguro", "crédito", "inmobiliaria",
# "carros", "celular": como negativa de frase bloquearían "software para
# inmobiliarias" o "sistema para concesionario", que son clientes ideales.
# Lo que hay que filtrar es quién busca empleo, quién quiere algo gratis para
# descargar y quién está aprendiendo, no el sector del que viene la consulta.
# --------------------------------------------------------------------------
NEGATIVAS = [
    # Quien aprende o busca trabajo no compra software.
    "curso", "cursos", "tutorial", "tutoriales", "aprender", "estudiar",
    "carrera", "universidad", "estudiante", "pasantía", "pasantia",
    "prácticas", "practicas", "empleo", "empleos", "vacante", "vacantes",
    "sueldo", "salario", "contratar personal", "cv", "hoja de vida",
    # Patrones de búsqueda de empleo que no chocan con "horas de trabajo".
    "buscar trabajo", "ofertas de trabajo", "bolsa de trabajo", "trabajar en",
    # Quiere gratis o quiere descargar, no contratar.
    "gratis", "gratuito descargar", "barato", "económico", "economico",
    "por hora", "freelance barato", "descargar", "pdf", "libro", "ebook",
    "crack", "pirata", "licencia gratis",
    # Quiere hacerlo solo con una herramienta de autoservicio.
    "wix", "wordpress gratis", "shopify gratis", "plantilla", "plantillas",
    # Está investigando el concepto, no comprando.
    "qué es", "que es", "definición", "definicion", "ejemplo", "wikipedia",
    "open source", "código fuente", "codigo fuente", "github",
    # Soporte de hardware, otra necesidad por completo.
    "reparar pc", "arreglar computador", "soporte técnico gratuito",
]

# --------------------------------------------------------------------------
# Meta: copys por conjunto de anuncios. Los límites visibles de Meta son más
# cortos de lo que la gente cree; lo que se pasa se trunca con "…".
# --------------------------------------------------------------------------
META_ADS = [
    {
        "adset": "PYME LatAm · Prospección",
        "angle": "Dolor: procesos manuales",
        "primary": "¿Sigues llevando pedidos, inventario o aprobaciones en Excel y WhatsApp? Te decimos qué conviene automatizar primero.",
        "headline": "Diagnóstico gratuito de procesos",
        "description": "Plan escrito. Sin costo.",
        "cta": "Más información",
        "landing": "/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=dolor_excel",
    },
    {
        "adset": "PYME LatAm · Prospección",
        "angle": "Resultado: tiempo recuperado",
        "primary": "Una pyme no necesita más herramientas: necesita que la información no se pierda. Revisamos tu proceso y te damos un plan.",
        "headline": "Qué automatizar y qué no",
        "description": "Sesión gratis de 30 minutos.",
        "cta": "Más información",
        "landing": "/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=plan_concreto",
    },
    {
        "adset": "PYME LatAm · Prospección",
        "angle": "Dolor: pauta sin retorno",
        "primary": "Si pagas pauta y no sabes cuántas consultas trajo, el problema no es el anuncio. Es la oferta, la página y el seguimiento.",
        "headline": "Por qué tu pauta no trae leads",
        "description": "Lo revisamos contigo. Gratis.",
        "cta": "Más información",
        "landing": "/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=pauta_sin_retorno",
    },
    {
        "adset": "PYME LatAm · Prospección",
        "angle": "Ahorro: ya pagas la licencia",
        "primary": "Tu empresa ya paga Microsoft 365. Power Apps, Power Automate y Power BI están incluidos y casi nadie los usa bien.",
        "headline": "Aprovecha tu Microsoft 365",
        "description": "Apps sin licencias nuevas.",
        "cta": "Más información",
        "landing": "/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_prospeccion&utm_content=licencia_ya_paga",
    },
    {
        "adset": "Retargeting · Visitantes y FormStart",
        "angle": "Retargeting: vio el sitio y no agendó",
        "primary": "Viste el sitio y no agendaste. Son 30 minutos, sin costo, y sales con un plan escrito de qué automatizar primero.",
        "headline": "Diagnóstico de 30 minutos",
        "description": "Sin costo ni compromiso.",
        "cta": "Más información",
        "landing": "/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_retargeting&utm_content=visitante_90d",
    },
    {
        "adset": "Retargeting · Visitantes y FormStart",
        "angle": "Retargeting: empezó el formulario",
        "primary": "Dejaste el formulario a medias. Cuéntanos qué proceso te consume tiempo y te decimos si vale la pena automatizarlo.",
        "headline": "Retomemos donde quedaste",
        "description": "30 minutos. Plan escrito.",
        "cta": "Más información",
        "landing": "/lp/diagnostico-gratis?utm_source=meta&utm_medium=cpc&utm_campaign=meta_retargeting&utm_content=form_sin_enviar",
    },
]

# --------------------------------------------------------------------------
# Conjuntos de Meta. El presupuesto es "Total" (lifetime) y no diario a
# propósito: Meta solo permite programar por franja horaria con presupuesto
# total. Con presupuesto diario la restricción 10:00-20:00 no se puede aplicar.
# --------------------------------------------------------------------------
META_ADSETS = [
    {
        "nombre": "PYME LatAm · Prospección",
        "objetivo": "Clientes potenciales (Leads)",
        "presupuesto": "150.00",
        "tipo": "Total por semana",
        "optimizar": "Clientes potenciales máximos",
        "destino": "Formulario instantáneo (Instant Form) con 2 preguntas de calificación",
        "publico": "Amplio: 28-60, sin intereses. Ver 03-meta-ads.md",
        "geo": "Ciudad de México, Bogotá, Santiago, Buenos Aires, Lima, Quito, Ciudad de Panamá, San José, Montevideo, Ciudad de Guatemala, San Salvador, Santo Domingo",
        "programacion": "Lun-Vie 10:00-20:00 (hora de la cuenta publicitaria)",
        "ubicaciones": "Automáticas",
    },
    {
        "nombre": "Retargeting · Visitantes y FormStart",
        "objetivo": "Clientes potenciales (Leads)",
        "presupuesto": "50.00",
        "tipo": "Total por semana",
        "optimizar": "Clientes potenciales máximos",
        "destino": "Landing page /lp/diagnostico-gratis",
        "publico": "Retargeting · Visitantes web 90 días + Retargeting · FormStart sin envío",
        "geo": "Los mismos 12 países del conjunto de prospección",
        "programacion": "Todo el día, sin restricción horaria",
        "ubicaciones": "Automáticas",
    },
]

META_AUDIENCIAS = [
    {
        "nombre": "PYME · Intereses de gestión",
        "edad": "28-60",
        "genero": "Todos",
        "detalle": "Intereses: Administración de empresas, Emprendimiento, Pequeña y mediana empresa, Microsoft Power BI, Automatización",
        "nota": "Excluir: estudiantes, 'busco empleo', marketing digital como interés (atrae colegas, no clientes)",
    },
    {
        "nombre": "Administradores de páginas de Facebook",
        "edad": "28-60",
        "genero": "Todos",
        "detalle": "Comportamientos > Actividades digitales > Administradores de páginas de Facebook (y de páginas de empresa)",
        "nota": "El mejor proxy B2B que tiene Meta: quien administra una página de empresa suele decidir o influir",
    },
    {
        "nombre": "Cargos: gerencia y operaciones",
        "edad": "30-62",
        "genero": "Todos",
        "detalle": "Datos demográficos > Trabajo > Cargos: Gerente general, Gerente de operaciones, Director de operaciones, Propietario, Fundador, Director de tecnología",
        "nota": "Volumen bajo por país; agrupa 3-5 países por conjunto para que entregue",
    },
    {
        "nombre": "Retargeting · Visitantes web 90 días",
        "edad": "25-65",
        "genero": "Todos",
        "detalle": "Público personalizado > Sitio web > Todas las personas que visitaron tu sitio web (90 días)",
        "nota": "Requiere el Pixel recibiendo tráfico. Encender recién con 500+ visitas acumuladas",
    },
    {
        "nombre": "Retargeting · FormStart sin envío",
        "edad": "25-65",
        "genero": "Todos",
        "detalle": "Público personalizado > Evento personalizado: FormStart (últimos 30 días), excluyendo el evento Lead",
        "nota": "El de mayor intención de todos. Empieza a existir en cuanto el pixel registre FormStart",
    },
]


def write_csv(name, header, rows):
    path = os.path.join(OUT, name)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"  {name}: {len(rows)} filas")
    return path


def keyword_text(kw, match):
    """Google lee el tipo de concordancia en la sintaxis, no en una columna."""
    if kw.startswith("["):
        return kw
    if match == "Exact":
        return f"[{kw}]"
    if match == "Phrase":
        return f'"{kw}"'
    return kw


def build_google():
    kw_rows, ad_rows, neg_rows, camp_rows, geo_rows, sched_rows = [], [], [], [], [], []

    for camp_name, camp in CAMPAIGNS.items():
        for neg in NEGATIVAS:
            # Ad Group vacío = negativa a nivel de campaña, no de grupo.
            neg_rows.append([camp_name, "", neg, "Phrase"])

        # Sin "Bid Strategy Goal" ni "Target CPA": la puja por CPA objetivo
        # necesita historial de conversiones. Se arranca en Maximizar clics con
        # CPC máximo y se cambia a conversiones en cuanto haya 30 leads.
        camp_rows.append([
            camp_name, "Search", camp.get("status", "Enabled"),
            f"{camp['budget']:.2f}", "USD",
            "Google search partners", "Maximize clicks", "Standard",
        ])

        for loc in UBICACIONES.get(camp_name, []):
            geo_rows.append([camp_name, loc])
        if not UBICACIONES.get(camp_name):
            errors.append(f"la campaña {camp_name!r} no tiene ubicaciones definidas")
        for day, start, end in HORARIO:
            sched_rows.append([camp_name, day, start, end])

        for ag_name, ag in camp["ad_groups"].items():
            for kw, match in ag["keywords"]:
                check("keyword", kw, 80, f"{camp_name} > {ag_name}")
                kw_rows.append([camp_name, ag_name, "Enabled",
                                keyword_text(kw, match), "", "", ""])

            h = OFERTA + ag["headlines"]
            if len(h) > 15:
                h = h[:15]
            for text in h:
                check("titular", text, GOOGLE_HEADLINE_MAX, f"{camp_name} > {ag_name}")
            for text in ag["descriptions"]:
                check("descripcion", text, GOOGLE_DESC_MAX, f"{camp_name} > {ag_name}")

            row = [camp_name, ag_name, "Responsive search ad", "Enabled",
                   ag["landing_url"] if "landing_url" in ag else LANDING]
            row += h + [""] * (15 - len(h))
            row += ag["descriptions"] + [""] * (4 - len(ag["descriptions"]))
            row += ag["paths"]
            ad_rows.append(row)

    write_csv("google-ads-campanas.csv",
              ["Campaign", "Campaign Type", "Campaign Status", "Budget", "Budget Type",
               "Networks", "Bid Strategy Type", "Ad Rotation"], camp_rows)

    write_csv("google-ads-geolocalizacion.csv",
              ["Campaign", "Location"], geo_rows)

    write_csv("google-ads-horario.csv",
              ["Campaign", "Day", "Start", "End"], sched_rows)

    write_csv("google-ads-keywords.csv",
              ["Campaign", "Ad Group", "Keyword Status", "Keyword",
               "Max CPC", "Final URL", "Labels"], kw_rows)

    write_csv("google-ads-anuncios.csv",
              ["Campaign", "Ad Group", "Ad Type", "Ad Status", "Final URL"] +
              [f"Headline {i}" for i in range(1, 16)] +
              [f"Description {i}" for i in range(1, 5)] +
              ["Path 1", "Path 2"], ad_rows)

    write_csv("google-ads-negativas.csv",
              ["Campaign", "Ad Group", "Negative Keyword", "Negative Keyword Match Type"],
              neg_rows)


LANDING = "https://opiasoftware.com/lp/diagnostico-gratis"


def build_meta():
    rows = []
    adset_names = {a["nombre"] for a in META_ADSETS}
    for ad in META_ADS:
        check("texto principal", ad["primary"], META_PRIMARY_MAX, ad["angle"])
        check("titular", ad["headline"], META_HEADLINE_MAX, ad["angle"])
        check("descripcion", ad["description"], META_DESC_MAX, ad["angle"])
        if ad["adset"] not in adset_names:
            errors.append(f"el anuncio {ad['angle']!r} apunta al conjunto inexistente {ad['adset']!r}")
        rows.append([
            ad["adset"], ad["angle"], ad["primary"], ad["headline"],
            ad["description"], ad["cta"],
            "https://opiasoftware.com" + ad["landing"],
        ])
    write_csv("meta-ads-copys.csv",
              ["Conjunto de anuncios", "Ángulo", "Texto principal (125)",
               "Titular (40)", "Descripción (30)", "Botón", "URL final con UTM"], rows)

    write_csv("meta-ads-conjuntos.csv",
              ["Nombre del conjunto", "Objetivo", "Presupuesto (USD)", "Tipo de presupuesto",
               "Optimizar para", "Público", "Ubicaciones geográficas", "Programación",
               "Ubicaciones de anuncio"],
              [[a["nombre"], a["objetivo"], a["presupuesto"], a["tipo"], a["optimizar"],
                a["publico"], a["geo"], a["programacion"], a["ubicaciones"]]
               for a in META_ADSETS])

    write_csv("meta-ads-audiencias.csv",
              ["Nombre del público", "Edad", "Género", "Configuración", "Nota"],
              [[a["nombre"], a["edad"], a["genero"], a["detalle"], a["nota"]] for a in META_AUDIENCIAS])


def main():
    print("Validando y generando archivos de pauta...\n")
    build_google()
    build_meta()

    if errors:
        print(f"\nERROR: {len(errors)} problemas detectados:\n")
        for e in errors:
            print("  -", e)
        sys.exit(1)

    print("\nOK: todos los textos respetan los limites de Google y Meta.")
    print(f"  Archivos en: {OUT}")


if __name__ == "__main__":
    main()
