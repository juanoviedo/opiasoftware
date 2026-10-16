#!/usr/bin/env python3
"""Importa los Excel de DatosInicialesCRM/ a server/data/crm/ (JSON).

Fuentes:
- contactoprospectosProcesado.xlsx : export Dynamics (entidad cr14c_contactoprospectos)
- Contactos Platec.xlsx           : 15 contactos del proyecto Platec

Uso (desde la raíz del repo):  python scripts/importar-crm.py
Solo biblioteca estándar. Los datos personales NUNCA se commitean:
esta carpeta y server/data/ están en .gitignore.
"""
import json
import re
import zipfile
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
RAIZ = Path(__file__).resolve().parent.parent
FUENTES = RAIZ / 'DatosInicialesCRM' / 'DatosClientesPT'
SALIDA = RAIZ / 'server' / 'data' / 'crm'

# columnas del export Dynamics (índice según encabezado del archivo)
COL = {
    'apellidos': 0, 'canal': 1, 'cargo': 2, 'comercialcanal': 3, 'contactarel': 4,
    'contactarenelfuturo': 5, 'guid': 6, 'descripcion': 7, 'email': 8, 'email2': 9,
    'email3': 10, 'empresa': 11, 'etapa': 12, 'leadscoring': 14, 'lugarorigen': 15,
    'nombres': 16, 'celular': 17, 'telefono': 18, 'telefono2': 19, 'observaciones': 20,
    'origen': 21, 'pais': 22, 'propietario': 23, 'sector': 24, 'estado': 25,
    'tags': 28, 'tipo': 30, 'tipodecliente': 31, 'ultimocontacto': 32, 'zona': 35,
}
# campos sueltos que van a notas del contacto para no perder información
EXTRA_NOTAS = ['canal', 'comercialcanal', 'contactarel', 'contactarenelfuturo',
               'lugarorigen', 'pais', 'tipo', 'tipodecliente']


def col_a_indice(ref):
    m = re.match(r'([A-Z]+)', ref)
    i = 0
    for c in m.group(1):
        i = i * 26 + (ord(c) - 64)
    return i - 1


def leer_xlsx(ruta):
    z = zipfile.ZipFile(ruta)
    cadenas = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si', NS):
            cadenas.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    root = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    filas = []
    for f in root.findall('.//m:sheetData/m:row', NS):
        d = {}
        for c in f.findall('m:c', NS):
            v = c.find('m:v', NS)
            if v is None:
                continue
            x = v.text or ''
            if c.get('t') == 's' and x.isdigit():
                x = cadenas[int(x)]
            d[col_a_indice(c.get('r'))] = x
        filas.append(d)
    return filas


def limpio(valor, maximo=300):
    if valor is None:
        return ''
    s = re.sub(r'[\x00-\x1F]', '', str(valor)).strip()
    if s.endswith('.0') and s[:-2].isdigit():
        s = s[:-2]
    return s[:maximo]


def fecha(valor):
    s = limpio(valor, 40)
    return s[:10] if s else ''


def ahora():
    return datetime.now(timezone.utc).isoformat()


def main():
    if not (FUENTES / 'contactoprospectosProcesado.xlsx').exists():
        raise SystemExit(f'No existe {FUENTES} — copia ahí los Excel del CRM viejo.')

    clientes, contactos = [], []
    por_nombre = {}
    seq_cli = seq_con = 0
    t = ahora()

    def cliente_para(nombre_empresa, sector='', zona=''):
        nonlocal seq_cli
        clave = re.sub(r'\s+', ' ', nombre_empresa.upper()).strip() or 'SIN EMPRESA'
        if clave in por_nombre:
            cli = por_nombre[clave]
            if sector and not cli['sector']:
                cli['sector'] = sector
            if zona and not cli['zona']:
                cli['zona'] = zona
            return cli
        seq_cli += 1
        cli = {
            'id': f'c{seq_cli:05d}',
            'nombre': nombre_empresa.strip() if nombre_empresa.strip() else '— Sin empresa —',
            'sector': limpio(sector, 120),
            'zona': limpio(zona, 120),
            'notas': '',
            'creadoEl': t,
            'actualizadoEl': t,
        }
        por_nombre[clave] = cli
        clientes.append(cli)
        return cli

    filas = leer_xlsx(FUENTES / 'contactoprospectosProcesado.xlsx')[1:]
    for f in filas:
        seq_con += 1
        empresa = limpio(f.get(COL['empresa'], ''), 200)
        cli = cliente_para(empresa, f.get(COL['sector'], ''), f.get(COL['zona'], ''))
        extras = []
        for campo in EXTRA_NOTAS:
            v = limpio(f.get(COL[campo], ''), 120)
            if v:
                extras.append(f'{campo}={v}')
        contactos.append({
            'id': f'p{seq_con:06d}',
            'clienteId': cli['id'],
            'nombres': limpio(f.get(COL['nombres'], ''), 120),
            'apellidos': limpio(f.get(COL['apellidos'], ''), 120),
            'cargo': limpio(f.get(COL['cargo'], ''), 160),
            'email': limpio(f.get(COL['email'], ''), 160),
            'email2': limpio(f.get(COL['email2'], ''), 160),
            'email3': limpio(f.get(COL['email3'], ''), 160),
            'celular': limpio(f.get(COL['celular'], ''), 40),
            'telefono': limpio(f.get(COL['telefono'], ''), 40),
            'telefono2': limpio(f.get(COL['telefono2'], ''), 40),
            'descripcion': limpio(f.get(COL['descripcion'], ''), 400),
            'sector': limpio(f.get(COL['sector'], ''), 120),
            'zona': limpio(f.get(COL['zona'], ''), 120),
            'origen': limpio(f.get(COL['origen'], ''), 120),
            'estado': limpio(f.get(COL['estado'], ''), 60),
            'etapa': limpio(f.get(COL['etapa'], ''), 120),
            'propietario': limpio(f.get(COL['propietario'], ''), 120),
            'leadScoring': limpio(f.get(COL['leadscoring'], ''), 20),
            'ultimoContacto': fecha(f.get(COL['ultimocontacto'], '')),
            'tags': limpio(f.get(COL['tags'], ''), 200),
            'observaciones': limpio(f.get(COL['observaciones'], ''), 500),
            'idExterno': limpio(f.get(COL['guid'], ''), 64),
            'notas': ' | '.join(extras),
            'creadoEl': t,
            'actualizadoEl': t,
        })

    platec = FUENTES / 'Contactos Platec.xlsx'
    if platec.exists():
        cli = cliente_para('PLATEC')
        for f in leer_xlsx(platec)[1:]:
            seq_con += 1
            extras = []
            for nombre, idx in (('Abreviación', 1), ('Tipo de elemento', 6), ('Ruta de acceso', 7)):
                v = limpio(f.get(idx, ''), 200)
                if v:
                    extras.append(f'{nombre}={v}')
            contactos.append({
                'id': f'p{seq_con:06d}',
                'clienteId': cli['id'],
                'nombres': limpio(f.get(0, ''), 160),
                'apellidos': '',
                'cargo': limpio(f.get(4, ''), 160),
                'email': limpio(f.get(2, ''), 160),
                'email2': '', 'email3': '',
                'celular': limpio(f.get(3, ''), 40),
                'telefono': '', 'telefono2': '',
                'descripcion': '',
                'sector': '', 'zona': limpio(f.get(5, ''), 120),
                'origen': '', 'estado': '', 'etapa': '', 'propietario': '',
                'leadScoring': '', 'ultimoContacto': '', 'tags': '', 'observaciones': '',
                'idExterno': '',
                'notas': ' | '.join(extras),
                'creadoEl': t,
                'actualizadoEl': t,
            })

    SALIDA.mkdir(parents=True, exist_ok=True)
    meta = {'seqCliente': seq_cli, 'seqContacto': seq_con, 'importadoEl': t}
    for nombre, datos in (('clientes.json', clientes), ('contactos.json', contactos), ('meta.json', meta)):
        destino = SALIDA / nombre
        destino.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'  {destino.relative_to(RAIZ)}  ({len(datos) if isinstance(datos, list) else 1} registros)')
    print(f'Listo: {len(clientes)} clientes, {len(contactos)} contactos.')


if __name__ == '__main__':
    main()
