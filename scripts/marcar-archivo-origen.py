#!/usr/bin/env python3
"""Marca el archivo origen de clientes y contactos ya existentes (trazabilidad).

Reglas:
- notas del cliente con marca bog_norte -> empresas_bognorte.csv
- cliente creado por dominio del correo -> dominio del correo (asignar-empresas-por-dominio.py)
- cliente PLATEC -> Contactos Platec.xlsx
- todo lo demas del primer volcado -> contactoprospectosProcesado.xlsx
- contacto con idExterno bog-* -> empresas_bognorte.csv

Uso: python scripts/marcar-archivo-origen.py [directorio_crm]
Respalda los JSON en respaldo-AAAA-MM-DD-HHMMSS/ antes de escribir.
"""
import json
import os
import shutil
import sys
from datetime import datetime

MARCA_BOG = 'Importado de la base antigua (bog_norte)'
MARCA_DOMINIO = 'Creada automáticamente desde el dominio de un correo'
BOG = 'empresas_bognorte.csv'
DYNAMICS = 'contactoprospectosProcesado.xlsx'
PLATEC = 'Contactos Platec.xlsx'
DOMINIO = 'dominio del correo (asignar-empresas-por-dominio.py)'


def cargar(ruta):
    with open(ruta, encoding='utf-8') as f:
        return json.load(f)


def guardar_atomico(ruta, datos):
    tmp = ruta + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False)
    os.replace(tmp, ruta)


def main(directorio):
    r_clientes = os.path.join(directorio, 'clientes.json')
    r_contactos = os.path.join(directorio, 'contactos.json')
    r_meta = os.path.join(directorio, 'meta.json')
    clientes = cargar(r_clientes)
    contactos = cargar(r_contactos)

    marca = datetime.now().strftime('%Y%m%d-%H%M%S')
    respaldo = os.path.join(directorio, f'respaldo-{marca}')
    os.makedirs(respaldo)
    for r in (r_clientes, r_contactos, r_meta):
        shutil.copy2(r, respaldo)

    nombres = {c['id']: c['nombre'] for c in clientes}
    origen_cliente = {}
    cambios_c = 0
    for c in clientes:
        notas = c.get('notas') or ''
        if notas.startswith(MARCA_BOG):
            origen = BOG
        elif notas.startswith(MARCA_DOMINIO):
            origen = DOMINIO
        elif nombres[c['id']] == 'PLATEC':
            origen = PLATEC
        else:
            origen = DYNAMICS
        origen_cliente[c['id']] = origen
        if not c.get('archivoOrigen'):
            c['archivoOrigen'] = origen
            cambios_c += 1

    cambios_k = 0
    for k in contactos:
        if k.get('archivoOrigen'):
            continue
        id_ext = k.get('idExterno') or ''
        if id_ext.startswith('bog-'):
            k['archivoOrigen'] = BOG
        elif nombres.get(k.get('clienteId')) == 'PLATEC':
            k['archivoOrigen'] = PLATEC
        else:
            k['archivoOrigen'] = DYNAMICS
        cambios_k += 1

    guardar_atomico(r_clientes, clientes)
    guardar_atomico(r_contactos, contactos)
    print(f'clientes marcados={cambios_c}/{len(clientes)} contactos marcados={cambios_k}/{len(contactos)}')
    print(f'respaldo en {respaldo}')


if __name__ == '__main__':
    raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    directorio = sys.argv[1] if len(sys.argv) > 1 else os.path.join(raiz, 'server', 'data', 'crm')
    main(directorio)
