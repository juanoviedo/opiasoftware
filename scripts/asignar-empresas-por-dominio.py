#!/usr/bin/env python3
"""Reagrupa los contactos "sin empresa" bajo un cliente nombrado por el dominio del correo.

Los contactos que quedaron en el cliente especial "— Sin empresa —" se mueven a un
cliente cuyo nombre es el dominio de su correo (lo que va después del @). Si ya
existe un cliente con ese nombre (comparación sin tildes ni mayúsculas) se reutiliza;
si no, se crea. El nombre del cliente sigue siendo editable en el CRM.

Uso: python scripts/asignar-empresas-por-dominio.py [directorio_crm]
Por defecto directorio_crm = server/data/crm (relativo a la raíz del repo).

Hace respaldo de los tres JSON en server/data/crm/respaldo-AAAA-MM-DD-HHMMSS/
antes de escribir, y escribe de forma atómica (tmp + rename).
"""
import json
import os
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timezone

SIN_EMPRESA = '— Sin empresa —'
DOMINIO_RE = re.compile(r'@([a-z0-9.-]+\.[a-z]{2,})\s*$', re.IGNORECASE)


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


def main(directorio):
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
    sin_empresa = por_nombre.get(normaliza(SIN_EMPRESA))
    if not sin_empresa:
        print(f'No se encontró el cliente "{SIN_EMPRESA}". Nada que hacer.')
        shutil.rmtree(respaldo)
        return

    seq = int(meta.get('seqCliente', 0))
    nuevos = {}
    movidos = 0
    sin_dominio = 0

    for k in contactos:
        if k.get('clienteId') != sin_empresa['id']:
            continue
        m = DOMINIO_RE.search(k.get('email') or '')
        if not m:
            sin_dominio += 1
            continue
        dominio = m.group(1).lower()
        if dominio.startswith('www.'):
            dominio = dominio[4:]
        dominio = dominio.rstrip('.')
        clave = normaliza(dominio)
        cliente = por_nombre.get(clave)
        if not cliente:
            seq += 1
            cliente = {
                'id': f'c{seq:05d}',
                'nombre': dominio,
                'sector': '',
                'zona': '',
                'notas': 'Creada automáticamente desde el dominio de un correo',
                'createdby': 'importacion',
                'createdon': ahora_utc(),
                'modifiedby': 'importacion',
                'modifiedon': ahora_utc(),
            }
            clientes.append(cliente)
            por_nombre[clave] = cliente
            nuevos[dominio] = cliente
        k['clienteId'] = cliente['id']
        k['modifiedby'] = 'importacion'
        k['modifiedon'] = ahora_utc()
        movidos += 1

    meta['seqCliente'] = seq
    guardar_atomico(r_clientes, clientes)
    guardar_atomico(r_contactos, contactos)
    guardar_atomico(r_meta, meta)
    print(f'movidos={movidos} nuevos_clientes={len(nuevos)} sin_dominio={sin_dominio} '
          f'total_clientes={len(clientes)} total_contactos={len(contactos)}')
    print(f'respaldo en {respaldo}')


if __name__ == '__main__':
    raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    directorio = sys.argv[1] if len(sys.argv) > 1 else os.path.join(raiz, 'server', 'data', 'crm')
    main(directorio)
