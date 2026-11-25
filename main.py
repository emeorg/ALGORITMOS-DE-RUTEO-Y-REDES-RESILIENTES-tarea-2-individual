#!/usr/bin/env python3
"""One-command runner; Docker bootstrap uses only Python's standard library."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent


def arguments():
    p = argparse.ArgumentParser(description='Resiliencia de la Internet chilena ante el terremoto 27F (M 8.8)')
    p.add_argument('--native', action='store_true', help='Usar Python y DATABASE_URL disponibles, sin Docker bootstrap')
    p.add_argument('--rebuild', action='store_true', help='Reconstruir el esquema resiliencia desde los datos originales')
    p.add_argument('--no-serve', action='store_true', help='Calcular y exportar sin levantar el servidor web')
    p.add_argument('--infrastructure', type=Path, help='GeoJSON/KML/KMZ WGS84; por defecto ZIP SAIP adjunto')
    p.add_argument('--nodes', type=Path, default=Path('data/nodos_clave.geojson'))
    p.add_argument('--synthetic', type=Path, default=Path('data/enlaces_sinteticos.geojson'),
                   help='Enlaces sintéticos declarados y justificados (GeoJSON WGS84)')
    p.add_argument('--no-synthetic', action='store_true', help='Omitir enlaces sintéticos (evaluar solo fibra SAIP pura)')
    p.add_argument('--source-url', default='SUBTEL SAIP AN002T0005610, ORD. 7479/G (29-05-2023)')
    p.add_argument('--iterations', type=int, default=20000)
    p.add_argument('--seed', type=int, default=27)
    p.add_argument('--site', choices=('soil', 'rock'), default='soil',
                   help='Condición de sitio Youngs et al. (1997): soil (por defecto) o rock')
    p.add_argument('--median-pga', type=float, default=0.33,
                   help='PGA mediana A_m (g) de curva lognormal HAZUS-MH (por defecto 0.33 g: Hazus 5.1, Tabla 8-30, circuitos estándar, daño moderado)')
    p.add_argument('--beta', type=float, default=0.20,
                   help='Dispersión logarítmica beta de curva HAZUS-MH (por defecto 0.20)')
    p.add_argument('--tolerance-m', type=float, default=10.0)
    p.add_argument('--snap-limit-m', type=float, default=250.0)
    p.add_argument('--sensitivity', action='store_true',
                   help='Comparar escenarios publicados: sitio soil/rock (Youngs 1997) × curvas HAZUS-MH')
    return p.parse_args()


def bootstrap():
    os.chdir(ROOT)
    # Cross-platform UID/GID fallback (os.getuid/getgid do not exist on Windows)
    os.environ['APP_UID'] = str(getattr(os, 'getuid', lambda: 1000)())
    os.environ['APP_GID'] = str(getattr(os, 'getgid', lambda: 1000)())
    port = os.environ.get('APP_PORT', '8082')
    compose = ['docker', 'compose', '-f', str(ROOT / 'compose.yaml')]
    no_serve = '--no-serve' in sys.argv
    subprocess.run(compose + ['up', '-d', '--wait', 'db'], check=True)
    services = ['app'] if no_serve else ['app', 'web']
    subprocess.run(compose + ['build'] + services, check=True)
    app_args = [a for a in sys.argv[1:] if a != '--no-serve']
    subprocess.run(compose + ['run', '--rm', 'app', 'python', 'main.py', '--native', '--no-serve'] + app_args, check=True)
    if not no_serve:
        print(f'Mapa Next.js + shadcn/ui + Leaflet disponible en http://localhost:{port}', flush=True)
        subprocess.run(compose + ['up', 'web'], check=True)


def write_json(path, document):
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False))


def pipeline(args):
    import psycopg
    from psycopg.types.json import Jsonb
    from src.database import build, export_sql, rows, update_probabilities
    from src.reliability import HAZUS_PRESETS, attr, failure_probability
    from src.sources import (
        ATTR_BOETTCHER_URL,
        ATTR_RUEDA_URL,
        GMPE_PAPER_URL,
        HAZUS_URL,
        STUDY_URL,
        USGS_DETAIL_URL,
        USGS_URL,
        ensure_usgs_shakemap,
        prepare_saip,
    )

    failure_probability(0.0, site=args.site, median_pga=args.median_pga, beta=args.beta)
    if (args.iterations < 2
            or not all(math.isfinite(v) for v in (args.tolerance_m, args.snap_limit_m))
            or args.tolerance_m <= 0 or args.snap_limit_m < 0):
        raise ValueError('Iteraciones >=2, tolerancia positiva y umbral de asociación >=0 requeridos.')

    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    archive = ROOT / 'Respuesta_T5610.zip'
    layers = prepare_saip(archive, output / 'layers') if archive.exists() else {}
    infrastructure = args.infrastructure or layers.get('fibra_optica_detectada')
    synthetic_path = None if args.no_synthetic else (ROOT / args.synthetic if not args.synthetic.is_absolute() else args.synthetic)
    nodes_path = ROOT / args.nodes if not args.nodes.is_absolute() else args.nodes
    event = ROOT / 'data/raw/terremoto_27f.geojson'
    if not event.exists():
        event.parent.mkdir(parents=True, exist_ok=True)
        with urlopen(USGS_URL, timeout=45) as response:
            event.write_bytes(response.read())
    rupture_path = ROOT / 'data/raw/rupture_27f.geojson'
    shakemap_path = ROOT / 'data/raw/shakemap_mmi_27f.geojson'
    ensure_usgs_shakemap(rupture_path, shakemap_path)

    sql_path = ROOT / 'main.sql'
    with psycopg.connect(os.environ.get('DATABASE_URL', 'postgresql://resiliencia:resiliencia_local@localhost:5432/resiliencia')) as conn:
        if sql_path.exists() and not args.rebuild and not args.infrastructure and not args.no_synthetic:
            print('Cargando main.sql en el esquema aislado resiliencia...', flush=True)
            conn.execute(sql_path.read_text())
            conn.commit()
            settings = rows(conn, "SELECT value FROM resiliencia.metadata WHERE key='settings'")[0]['value']
            if settings.get('demo'):
                raise ValueError('El SQL contiene datos demo; reconstruye con --rebuild.')
            if settings['tolerance_m'] != args.tolerance_m or settings['snap_limit_m'] != args.snap_limit_m:
                raise ValueError('La tolerancia/umbral difiere del SQL; usa --rebuild.')
            tracked = [p for p in (archive, nodes_path, synthetic_path, event, rupture_path) if p and p.exists()]
            for file in tracked:
                expected = settings.get('input_sha256', {}).get(file.name)
                if expected and hashlib.sha256(file.read_bytes()).hexdigest() != expected:
                    raise ValueError(f'{file.name} cambió respecto del SQL; usa --rebuild.')
        else:
            if not infrastructure or not Path(infrastructure).exists():
                raise ValueError('Falta Respuesta_T5610.zip o --infrastructure con una red documentada.')
            print('Importando infraestructura y creando topología con pgr_createTopology...', flush=True)
            build(
                conn,
                infrastructure,
                nodes_path,
                event,
                False,
                args.tolerance_m,
                args.snap_limit_m,
                args.source_url,
                synthetic_links=synthetic_path,
                rupture=rupture_path,
            )

        eq = rows(
            conn,
            'SELECT id, magnitude, depth_km, ST_X(geom) AS lon, ST_Y(geom) AS lat, rupture_geom IS NOT NULL AS has_rupture FROM resiliencia.earthquake LIMIT 1',
        )[0]
        has_rupture = bool(eq.pop('has_rupture'))
        edge_rows = rows(conn, 'SELECT id, name, source, target, p_failure, distance_km, pga_g, synthetic FROM resiliencia.edges ORDER BY id')
        nodes = rows(conn, 'SELECT id, name, role, vertex_id, snap_distance_m, reference, justification FROM resiliencia.key_nodes ORDER BY id')
        vertices = [r['id'] for r in rows(conn, 'SELECT id FROM resiliencia.edges_vertices_pgr ORDER BY id')]
        terminals = [r['vertex_id'] for r in nodes]

        print('Calculando ATTR en operación (p_falla = 0)...', flush=True)
        baseline = attr(vertices, [(e['source'], e['target'], 0.0) for e in edge_rows], terminals, args.iterations, args.seed)

        print(f'Aplicando modelo sísmico Youngs (1997) [{args.site}] + HAZUS-MH (A_m={args.median_pga} g, beta={args.beta})...', flush=True)
        update_probabilities(conn, site=args.site, median_pga=args.median_pga, beta=args.beta)
        edge_rows = rows(conn, 'SELECT id, name, source, target, p_failure, distance_km, pga_g, synthetic FROM resiliencia.edges ORDER BY id')

        print('Calculando ATTR post-terremoto 27F...', flush=True)
        after = attr(vertices, [(e['source'], e['target'], e['p_failure']) for e in edge_rows], terminals, args.iterations, args.seed)

        components = rows(conn, """SELECT component, count(*) AS vertices FROM pgr_connectedComponents(
            'SELECT id, source, target, 1::float8 AS cost FROM resiliencia.edges') GROUP BY component ORDER BY vertices DESC""")
        raw_saip_components = rows(conn, """SELECT component, count(*) AS vertices FROM pgr_connectedComponents(
            'SELECT id, source, target, 1::float8 AS cost FROM resiliencia.edges WHERE NOT synthetic') GROUP BY component ORDER BY vertices DESC""")
        edge_lengths = rows(conn, """SELECT synthetic, count(*) AS edges,
            sum(ST_Length(ST_Transform(geom, 4326)::geography))/1000.0 AS length_km
            FROM resiliencia.edges GROUP BY synthetic ORDER BY synthetic""")

        for i, node in enumerate(nodes):
            node['connectivity_before'] = baseline['node_connectivity'][i]
            node['connectivity_after'] = after['node_connectivity'][i]
            node['connectivity_drop'] = baseline['node_connectivity'][i] - after['node_connectivity'][i]
            node['unmatched'] = node['vertex_id'] < 0

        layer_stats = []
        for name, path in layers.items():
            doc = json.loads(path.read_text())
            length = 0.0
            for feature in doc['features']:
                length += rows(
                    conn,
                    'SELECT ST_Length(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)::geography)/1000 AS km',
                    (json.dumps(feature['geometry']),),
                )[0]['km']
            layer_stats.append(dict(
                layer=name,
                features=len(doc['features']),
                length_km=length,
                used_as_network=(name == 'fibra_optica_detectada'),
            ))

        difference = after['value'] - baseline['value']
        relative_change = (100.0 * difference / baseline['value']) if baseline['value'] else None
        settings = rows(conn, "SELECT value FROM resiliencia.metadata WHERE key='settings'")[0]['value']
        if args.rebuild or not sql_path.exists() or args.no_synthetic:
            tracked = [p for p in (archive, nodes_path, synthetic_path, event, rupture_path) if p and p.exists()]
            settings['input_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in tracked}

        real_edges = [e for e in edge_rows if not e['synthetic']]
        synth_edges = [e for e in edge_rows if e['synthetic']]

        warnings = [
            'La capa SAIP original (~10.312,8 km de fibra observada en 2018) presenta 168 componentes desconectadas. El Estudio SUBTEL 2018 distingue fibra observada y recorridos de inspección; su Supuesto S2 asume conexiones entre comunas del Gran Santiago sin validación en terreno.',
            f'Se incorporan {len(synth_edges)} enlaces sintéticos explícitamente marcados (synthetic=true) y justificados (acometidas urbanas, anillo metropolitano de Santiago, continuidad troncal y cable submarino SAm-1) para conectar los nodos clave; pueden distinguirse visualmente en Leaflet.',
            'Anacronismo temporal: se evalúa el sismo histórico del 27-02-2010 sobre infraestructura levantada en 2018 y nodos clave documentados en PeeringDB/TeleGeography.',
            'El modelo Youngs et al. (1997) usa la distancia 3D más cercana (R_rup) al plano de ruptura oficial USGS ShakeMap (Hayes 2011b, ~500 km de extensión) y asume condición homogénea de sitio.',
            'La excedencia del daño moderado en circuitos eléctricos estándar se interpreta como interrupción del enlace de fibra: es una adaptación del estudio sin calibración específica para fibra. Las fallas de enlaces se suponen independientes condicionadas al sismo; no se modelan fallas de nodos/data centers, cortes eléctricos, tsunami, licuefacción ni tiempos de reparación.',
        ]
        if baseline['value'] == 0:
            warnings.insert(0, 'ATTR inicial=0: ningún par de nodos clave está conectado en los datos.')

        summary = dict(
            status='completo',
            demo=False,
            earthquake=eq,
            before=baseline,
            after=after,
            difference=difference,
            relative_change_percent=relative_change,
            network=dict(
                edges=len(edge_rows),
                real_edges=len(real_edges),
                synthetic_edges=len(synth_edges),
                edge_lengths=edge_lengths,
                vertices=len(vertices),
                components=len(components) + sum(n['unmatched'] for n in nodes),
                raw_saip_components=len(raw_saip_components),
                isolated_key_nodes=sum(n['unmatched'] for n in nodes),
                component_sizes=components[:25],
            ),
            key_nodes=nodes,
            layers=layer_stats,
            model=dict(
                name='Youngs et al. (1997) GMPE + FEMA HAZUS-MH (Ch. 8) Fragilidad Lognormal',
                gmpe_reference='Youngs, Chiou, Silva & Humphrey (1997), Seismological Research Letters, 68(1), 58-73',
                gmpe_url=GMPE_PAPER_URL,
                fragility_reference='FEMA Hazus 5.1 (2022), Table 8-30: Distribution Circuits, Standard Components, Moderate damage',
                fragility_url=HAZUS_URL,
                function='PGA(g) = exp(c1 + c2*M + c3*ln(R_rup + c4*exp(c5*M)) + c6*H + c7*Z_T); p(e) = Phi(ln(PGA/A_m)/beta)',
                distance_metric='R_rup' if has_rupture else 'R_hyp',
                site=args.site,
                magnitude=eq['magnitude'],
                depth_km=eq['depth_km'],
                z_t=0,
                median_pga_g=args.median_pga,
                beta=args.beta,
                parameters_status='Youngs et al. (1997); fragilidad seleccionada de Hazus 5.1, con adaptación a interrupción de enlaces; ruptura USGS (Hayes 2011b)',
            ),
            settings=settings,
            sources=dict(
                study=STUDY_URL,
                earthquake=USGS_URL,
                shakemap=USGS_DETAIL_URL,
                gmpe=GMPE_PAPER_URL,
                fragility=HAZUS_URL,
                attr_boettcher=ATTR_BOETTCHER_URL,
                attr_rueda=ATTR_RUEDA_URL,
            ),
            warnings=warnings,
            most_affected=sorted(edge_rows, key=lambda e: e['p_failure'], reverse=True)[:10],
            least_affected=sorted(edge_rows, key=lambda e: (e['p_failure'], -e['distance_km']))[:10],
            most_affected_nodes=sorted(nodes, key=lambda n: n['connectivity_after'])[:5],
        )

        if args.sensitivity:
            print('Ejecutando análisis de sensibilidad (Youngs 1997 soil/rock × curvas HAZUS-MH)...', flush=True)
            summary['sensitivity'] = []
            for site_opt in ('soil', 'rock'):
                for preset_key, preset in HAZUS_PRESETS.items():
                    sim_edges = [
                        (
                            e['source'],
                            e['target'],
                            failure_probability(
                                e['distance_km'],
                                magnitude=eq['magnitude'],
                                depth_km=eq['depth_km'],
                                site=site_opt,
                                median_pga=preset['median_pga'],
                                beta=preset['beta'],
                                is_rupture_distance=has_rupture,
                            ),
                        )
                        for e in edge_rows
                    ]
                    res_s = attr(vertices, sim_edges, terminals, args.iterations, args.seed)
                    summary['sensitivity'].append(dict(
                        site=site_opt,
                        preset=preset_key,
                        label=preset['label'],
                        median_pga_g=preset['median_pga'],
                        beta=preset['beta'],
                        attr=res_s['value'],
                        ci95=res_s['ci95'],
                        drop_percent=100.0 * (res_s['value'] - baseline['value']) / baseline['value'] if baseline['value'] else None,
                    ))

        if args.sensitivity:
            point_distances = rows(conn, """SELECT e.source, e.target,
                ST_Distance(e.geom, ST_Transform(q.geom, 32719))/1000.0 AS distance_km
                FROM resiliencia.edges e CROSS JOIN resiliencia.earthquake q
                ORDER BY e.id""")
            point_edges = [(e['source'], e['target'], failure_probability(
                e['distance_km'], magnitude=eq['magnitude'], depth_km=eq['depth_km'],
                site=args.site, median_pga=args.median_pga, beta=args.beta,
                is_rupture_distance=False)) for e in point_distances]
            summary['epicentral_comparison'] = attr(
                vertices, point_edges, terminals, args.iterations, args.seed)

        conn.execute("INSERT INTO resiliencia.metadata VALUES ('settings',%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (Jsonb(settings),))
        conn.execute("INSERT INTO resiliencia.metadata VALUES ('results',%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (Jsonb(summary),))
        conn.commit()

        write_json(output / 'results.json', summary)

        features = []
        for row in rows(
            conn,
            """SELECT id, name, p_failure, distance_km, pga_g, synthetic,
                      provenance->>'justification' AS justification,
                      provenance->>'category' AS category,
                      ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry
               FROM resiliencia.edges ORDER BY id""",
        ):
            geometry = row.pop('geometry')
            features.append(dict(type='Feature', geometry=geometry, properties=row))
        write_json(output / 'edges.geojson', dict(type='FeatureCollection', features=features))

        features = []
        for node, row in zip(nodes, rows(conn, 'SELECT ST_AsGeoJSON(geom)::json AS geometry FROM resiliencia.key_nodes ORDER BY id')):
            features.append(dict(type='Feature', geometry=row['geometry'], properties=node))
        write_json(output / 'nodes.geojson', dict(type='FeatureCollection', features=features))

        write_json(output / 'earthquake.geojson', rows(conn, 'SELECT feature FROM resiliencia.earthquake')[0]['feature'])
        rupture_row = rows(conn, 'SELECT rupture_feature FROM resiliencia.earthquake')[0]['rupture_feature']
        if rupture_row is not None:
            write_json(output / 'rupture.geojson', rupture_row)
        if shakemap_path.exists():
            (output / 'shakemap.geojson').write_bytes(shakemap_path.read_bytes())
        if not args.no_synthetic:
            export_sql(conn, sql_path)
        write_json(
            output / 'topology.json',
            dict(
                settings=settings,
                vertices=rows(conn, 'SELECT id, ST_X(the_geom) AS x, ST_Y(the_geom) AS y FROM resiliencia.edges_vertices_pgr ORDER BY id'),
            ),
        )

        print(json.dumps(dict(
            ATTR_antes=round(baseline['value'], 6),
            ATTR_despues=round(after['value'], 6),
            IC_95_despues=[round(x, 6) for x in after['ci95']],
            diferencia=round(difference, 6),
            cambio_porcentual=round(relative_change, 2) if relative_change is not None else None,
            enlaces_reales_SAIP=len(real_edges),
            enlaces_sinteticos_declarados=len(synth_edges),
            nodos_clave=len(nodes),
            nodos_sin_asociar=summary['network']['isolated_key_nodes'],
            componentes_SAIP_original=len(raw_saip_components),
            componentes_integradas=summary['network']['components'],
        ), indent=2, ensure_ascii=False), flush=True)
        print('Resultados: output/results.json | SQL portable: main.sql', flush=True)


def serve_native():
    port = os.environ.get('APP_PORT', '8082')
    env = {**os.environ, 'OUTPUT_DIR': str(ROOT / 'output'), 'PORT': port}
    web_dir = ROOT / 'web'
    if not (web_dir / 'node_modules').exists():
        subprocess.run(['bun', 'install', '--frozen-lockfile'], cwd=web_dir, env=env, check=True)
    if not (web_dir / '.next').exists():
        subprocess.run(['bun', 'run', 'build'], cwd=web_dir, env=env, check=True)
    print(f'Mapa Next.js + shadcn/ui + Leaflet disponible en http://localhost:{port}', flush=True)
    subprocess.run(['bun', 'run', 'start'], cwd=web_dir, env=env, check=True)


if __name__ == '__main__':
    args = arguments()
    try:
        if not args.native and os.environ.get('APP_CONTAINER') != '1':
            bootstrap()
        else:
            os.chdir(ROOT)
            pipeline(args)
            if not args.no_serve:
                serve_native()
    except KeyboardInterrupt:
        sys.exit(0)
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
