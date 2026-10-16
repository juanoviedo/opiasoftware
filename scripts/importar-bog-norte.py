#!/usr/bin/env python3
"""Importa empresas_bognorte.csv (base antigua del laboratorio) al CRM.

Cada fila es una empresa con su numero de trabajadores (columna numtrabajadores),
actividad economica, ciudad, telefonos y hasta cinco contactos (encargado1/2,
ori, dmo, fac). Las empresas que ya existen en el CRM (mismo nombre sin tildes
ni mayúsculas) se reutilizan: se les completa sector/zona y numEmpleadosAprox
si venían vacíos; las nuevas se crean con la columna Empleados aprox.

Uso: python scripts/importar-bog-norte.py <ruta_empresas_bognorte.csv> [directorio_crm]
El CSV vive fuera del repo (Documentos/Contactos BKUP/) y se pasa como argumento;
directorio_crm por defecto = server/data/crm relativo a la raíz del repo.

Solo biblioteca estándar. Datos personales NUNCA se commitean: el CSV de origen
y server/data/ están en .gitignore. Respalda clientes/contactos/meta en
server/data/crm/respaldo-AAAA-MM-DD-HHMMSS/ antes de escribir, y escribe de
forma atómica (tmp + rename).
"""
import csv
import json
import os
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timezone

# índices de columna en empresas_bognorte.csv (delimitador ;)
IDX = {
    'idempresa': 0, 'empresa': 1, 'direccion': 2, 'ciudad': 3,
    'telefono': 7, 'telefono2': 8, 'celular': 9,
    'encargado1': 11, 'tel1': 12, 'cargo1': 13,
    'encargado2': 14, 'tel2': 15, 'cargo2': 16,
    'actividad': 23, 'email': 26,
    'numtrabajadores': 46,
    'ori_nombre': 48, 'ori_cargo': 49, 'ori_tel': 50,
    'dmo_nombre': 53, 'dmo_cargo': 54, 'dmo_tel': 55,
    'fac_nombre': 68, 'fac_cargo': 69, 'fac_tel': 70,
}
ROLES_CONTACTO = [
    ('encargado1', 'cargo1', 'tel1'),
    ('encargado2', 'cargo2', 'tel2'),
    ('ori_nombre', 'ori_cargo', 'ori_tel'),
    ('dmo_nombre', 'dmo_cargo', 'dmo_tel'),
    ('fac_nombre', 'fac_cargo', 'fac_tel'),
]
NOMBRES_BASURA = {'N/A', 'NA', '0', '-', '--', 'NINGUNA', 'NINGUNO', 'NO', 'X', 'XXX'}
MARCA_NOTA = 'Importado de la base antigua (bog_norte)'

# municipio (sin tildes, en mayúsculas) -> departamento, para el top de ciudades
# del archivo; lo que no se reconozca queda sin departamento.
CIUDAD_DEPTO = {
    'CALI': 'Valle del Cauca', 'PALMIRA': 'Valle del Cauca', 'YUMBO': 'Valle del Cauca',
    'TULUA': 'Valle del Cauca', 'BUENAVENTURA': 'Valle del Cauca',
    'GUADALAJARA DE BUGA': 'Valle del Cauca', 'BUGA': 'Valle del Cauca',
    'CANDELARIA': 'Valle del Cauca', 'JAMUNDI': 'Valle del Cauca',
    'FLORIDA': 'Valle del Cauca', 'PRADERA': 'Valle del Cauca', 'EL CERRITO': 'Valle del Cauca',
    'ZARZAL': 'Valle del Cauca', 'CALOTO': 'Cauca', 'SANTANDER DE QUILICHAO': 'Cauca',
    'VILLA RICA': 'Cauca', 'PUERTO TEJADA': 'Cauca', 'POPAYAN': 'Cauca',
    'BOGOTA': 'Bogotá D.C.', 'MEDELLIN': 'Antioquia', 'ITAGUI': 'Antioquia',
    'ENVIGADO': 'Antioquia', 'BELLO': 'Antioquia', 'RIONEGRO': 'Antioquia',
    'SABANETA': 'Antioquia', 'LA ESTRELLA': 'Antioquia', 'COPACABANA': 'Antioquia',
    'BARRANQUILLA': 'Atlántico', 'SOLEDAD': 'Atlántico', 'MALAMBO': 'Atlántico',
    'BUCARAMANGA': 'Santander', 'FLORIDABLANCA': 'Santander', 'GIRON': 'Santander',
    'PIEDECUESTA': 'Santander', 'PEREIRA': 'Risaralda', 'DOSQUEBRADAS': 'Risaralda',
    'SANTA ROSA DE CABAL': 'Risaralda', 'PASTO': 'Nariño', 'TUMACO': 'Nariño',
    'CARTAGENA': 'Bolívar', 'SINCELEJO': 'Sucre', 'MONTERIA': 'Córdoba',
    'IBAGUE': 'Tolima', 'ESPINAL': 'Tolima', 'NEIVA': 'Huila', 'GARZON': 'Huila',
    'MANIZALES': 'Caldas', 'VILLAMARIA': 'Caldas', 'ARMENIA': 'Quindío',
    'CUCUTA': 'Norte de Santander', 'VILLAVICENCIO': 'Meta', 'VALLEDUPAR': 'Cesar',
    'RIOHACHA': 'La Guajira', 'SANTA MARTA': 'Magdalena', 'BARRANCABERMEJA': 'Santander',
    'CALIMA': 'Valle del Cauca', 'DAGUA': 'Valle del Cauca', 'LA UNION': 'Valle del Cauca',
    'ROLDANILLO': 'Valle del Cauca', 'SEVILLA': 'Valle del Cauca', 'TORO': 'Valle del Cauca',
    'TRUJILLO': 'Valle del Cauca', 'ANDALUCIA': 'Valle del Cauca', 'BUGALAGRANDE': 'Valle del Cauca',
    'GINEBRA': 'Valle del Cauca',
}
CIUDAD_SUCA_RE = re.compile(r'^\d|[:"]|.{31,}')


def normaliza(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').upper().strip()


def cargar(ruta):
    with open(ruta, encoding='utf-8') as f:
        return json.load(f)


def guardar_atomico(ruta, datos):
    tmp = ruta + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False)
    os.replace(tmp, ruta)


def ahora_utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def celda(row, idx):
    return row[idx].strip() if idx < len(row) and row[idx] else ''


def numero_empleados(valor):
    if not valor:
        return None
    try:
        n = int(float(valor))
    except ValueError:
        return None
    return n if n > 0 else None


def dividir_correos(valor):
    partes = re.split(r'[/,;\s]+', valor or '')
    vistos, correos = set(), []
    for p in partes:
        p = p.strip().lower()
        if re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]{2,}', p) and p not in vistos:
            vistos.add(p)
            correos.append(p)
    return correos[:3]


def limpiar(valor, limite):
    return re.sub(r'\s+', ' ', str(valor or '')).strip()[:limite]


def ciudad_valida(valor):
    """La columna ciudad viene con filas desplazadas: teléfonos, notas largas…"""
    c = limpiar(valor, 60)
    if not c or normaliza(c) in NOMBRES_BASURA:
        return ''
    if CIUDAD_SUCA_RE.search(c):
        return ''
    return c[:120]


def departamento_de(ciudad):
    return CIUDAD_DEPTO.get(normaliza(ciudad), '') if ciudad else ''


def contactos_de_fila(row):
    """Contactos de la empresa deduplicados por nombre normalizado."""
    vistos = set()
    salida = []
    for k_nombre, k_cargo, k_tel in ROLES_CONTACTO:
        nombre = limpiar(celda(row, IDX[k_nombre]), 120)
        if not nombre or normaliza(nombre) in NOMBRES_BASURA:
            continue
        clave = normaliza(nombre)
        if clave in vistos:
            continue
        vistos.add(clave)
        cargo = limpiar(celda(row, IDX[k_cargo]), 160)
        if normaliza(cargo) in NOMBRES_BASURA:
            cargo = ''
        tel = limpiar(celda(row, IDX[k_tel]), 40)
        salida.append({'nombres': nombre, 'cargo': cargo, 'celular': tel})
    return salida


def telefono_de_fila(row):
    for k in ('telefono', 'telefono2', 'celular'):
        t = limpiar(celda(row, IDX[k]), 40)
        if t and normaliza(t) not in NOMBRES_BASURA and not t.startswith('0'):
            return t
    return ''


def leer_empresas(ruta_csv):
    with open(ruta_csv, encoding='utf-8-sig', errors='replace', newline='') as f:
        lector = csv.reader(f, delimiter=';')
        next(lector, None)  # encabezado
        for row in lector:
            if not row or not any(c.strip() for c in row):
                continue
            yield row


def main(ruta_csv, directorio):
    r_clientes = os.path.join(directorio, 'clientes.json')
    r_contactos = os.path.join(directorio, 'contactos.json')
    r_meta = os.path.join(directorio, 'meta.json')
    clientes = cargar(r_clientes)
    contactos = cargar(r_contactos)
    meta = cargar(r_meta)

    marca = datetime.now().strftime('%Y%m%d-%H%M%S')
    respaldo = os.path.join(directorio, f'respaldo-{marca}')
    os.makedirs(respaldo)
    for r in (r_clientes, r_contactos, r_meta):
        shutil.copy2(r, respaldo)

    por_nombre = {normaliza(c['nombre']): c for c in clientes}
    contactos_por_cliente = {}
    for k in contactos:
        contactos_por_cliente.setdefault(k.get('clienteId'), []).append(k)
    # dedupe de contactos nuevos contra los que ya existen en el cliente
    vistos_por_cliente = {
        cid: {normaliza(k.get('nombres')) for k in ks}
        for cid, ks in contactos_por_cliente.items()
    }

    seq_cliente = int(meta.get('seqCliente', 0))
    seq_contacto = int(meta.get('seqContacto', 0))
    vistos_csv = set()

    c_nuevos = c_reutilizados = c_repetidas_csv = c_sin_nombre = 0
    k_nuevos = k_saltados_existente = 0
    con_empleados = 0

    for row in leer_empresas(ruta_csv):
        nombre = limpiar(celda(row, IDX['empresa']), 200)
        if not nombre or normaliza(nombre) in NOMBRES_BASURA:
            c_sin_nombre += 1
            continue
        clave = normaliza(nombre)
        if clave in vistos_csv:
            c_repetidas_csv += 1
            continue
        vistos_csv.add(clave)

        correos = dividir_correos(celda(row, IDX['email']))
        num = numero_empleados(celda(row, IDX['numtrabajadores']))
        actividad = limpiar(celda(row, IDX['actividad']), 120)
        ciudad = ciudad_valida(celda(row, IDX['ciudad']))
        depto = departamento_de(ciudad)
        direccion = limpiar(celda(row, IDX['direccion']), 200)
        if normaliza(direccion) in NOMBRES_BASURA:
            direccion = ''
        telefono = telefono_de_fila(row)
        email = correos[0] if correos else ''

        cliente = por_nombre.get(clave)
        if cliente:
            c_reutilizados += 1
            if not cliente.get('sector') and actividad:
                cliente['sector'] = actividad
            zona_actual = cliente.get('zona') or ''
            if not zona_actual:
                if ciudad:
                    cliente['zona'] = ciudad
            elif not ciudad_valida(zona_actual) and cliente.get('notas', '').startswith(MARCA_NOTA):
                cliente['zona'] = ciudad  # ciudad basura del primer paso: se corrige
            if cliente.get('numEmpleadosAprox') in (None, '') and num is not None:
                cliente['numEmpleadosAprox'] = num
                cliente['actualizadoEl'] = ahora_utc()
            for campo, valor in (('direccion', direccion), ('departamento', depto),
                                 ('telefono', telefono), ('email', email)):
                if valor and not cliente.get(campo):
                    cliente[campo] = valor
                    cliente['actualizadoEl'] = ahora_utc()
            # la primera versión metía teléfonos/correos/dirección en notas;
            # ya viven en campos propios, se deja solo la marca de origen
            notas = cliente.get('notas') or ''
            if notas.startswith(MARCA_NOTA) and ' · ' in notas:
                cliente['notas'] = MARCA_NOTA
        else:
            c_nuevos += 1
            seq_cliente += 1
            cliente = {
                'id': f'c{seq_cliente:05d}',
                'nombre': nombre,
                'sector': actividad,
                'zona': ciudad,
                'notas': MARCA_NOTA,
                'numEmpleadosAprox': num,
                'direccion': direccion,
                'departamento': depto,
                'sitioWeb': '',
                'telefono': telefono,
                'email': email,
                'creadoEl': ahora_utc(),
                'actualizadoEl': ahora_utc(),
            }
            clientes.append(cliente)
            por_nombre[clave] = cliente
        if cliente.get('numEmpleadosAprox') not in (None, ''):
            con_empleados += 1

        id_ext = 'bog-' + (celda(row, IDX['idempresa']) or '?')
        vistos = vistos_por_cliente.setdefault(cliente['id'], set())
        for c in contactos_de_fila(row):
            if normaliza(c['nombres']) in vistos:
                continue
            vistos.add(normaliza(c['nombres']))
            seq_contacto += 1
            ahora = ahora_utc()
            contactos.append({
                'id': f'p{seq_contacto:06d}',
                'clienteId': cliente['id'],
                'nombres': c['nombres'],
                'apellidos': '',
                'cargo': c['cargo'],
                'email': '', 'email2': '', 'email3': '',
                'celular': c['celular'],
                'telefono': '', 'telefono2': '',
                'descripcion': '', 'sector': '', 'zona': '', 'origen': 'bog_norte',
                'estado': '', 'etapa': '', 'propietario': '', 'leadScoring': '',
                'ultimoContacto': '', 'tags': '', 'observaciones': '', 'notas': '',
                'idExterno': id_ext,
                'creadoEl': ahora,
                'actualizadoEl': ahora,
            })
            k_nuevos += 1

    meta['seqCliente'] = seq_cliente
    meta['seqContacto'] = seq_contacto
    guardar_atomico(r_clientes, clientes)
    guardar_atomico(r_contactos, contactos)
    guardar_atomico(r_meta, meta)
    print(f'empresas nuevas={c_nuevos} reutilizadas={c_reutilizados} '
          f'repetidas_en_csv={c_repetidas_csv} sin_nombre={c_sin_nombre}')
    print(f'contactos nuevos={k_nuevos} total_clientes={len(clientes)} '
          f'total_contactos={len(contactos)} clientes_con_empleados={con_empleados}')
    print(f'respaldo en {respaldo}')


if __name__ == '__main__':
    raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if len(sys.argv) < 2:
        sys.exit('Uso: python scripts/importar-bog-norte.py <ruta_empresas_bognorte.csv> [directorio_crm]')
    ruta_csv = sys.argv[1]
    directorio = sys.argv[2] if len(sys.argv) > 2 else os.path.join(raiz, 'server', 'data', 'crm')
    main(ruta_csv, directorio)
