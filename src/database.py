"""PostGIS import, pgRouting topology, seismic probabilities and portable SQL export."""
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from psycopg import sql
from psycopg.types.json import Jsonb

from src.reliability import fragility_hazus, pga_youngs1997

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
DROP SCHEMA IF EXISTS resiliencia CASCADE;
CREATE SCHEMA resiliencia;
CREATE TABLE resiliencia.edges (
 id bigserial PRIMARY KEY, name text NOT NULL, source bigint, target bigint,
 geom geometry(LineString,32719) NOT NULL,
 p_failure double precision NOT NULL DEFAULT 0 CHECK(p_failure BETWEEN 0 AND 1),
 distance_km double precision, pga_g double precision,
 synthetic boolean NOT NULL DEFAULT false,
 provenance jsonb NOT NULL
);
CREATE TABLE resiliencia.key_nodes (
 id bigserial PRIMARY KEY, name text NOT NULL, role text NOT NULL,
 geom geometry(Point,4326) NOT NULL, vertex_id bigint, snap_distance_m double precision,
 reference text NOT NULL, justification text NOT NULL
);
CREATE TABLE resiliencia.earthquake (
 id text PRIMARY KEY, magnitude double precision NOT NULL, depth_km double precision NOT NULL,
 geom geometry(Point,4326) NOT NULL, feature jsonb NOT NULL,
 rupture_geom geometry(MultiPolygonZ,4326), rupture_feature jsonb
);
CREATE TABLE resiliencia.metadata (key text PRIMARY KEY, value jsonb NOT NULL);
"""


def load_features(path):
    path = Path(path)
    if path.suffix.lower() in ('.kml', '.kmz'):
        if path.suffix.lower() == '.kmz':
            with zipfile.ZipFile(path) as archive:
                names = [n for n in archive.namelist() if n.lower().endswith('.kml')]
                if not names:
                    raise ValueError('KMZ sin documentos KML.')
                documents = [archive.read(n) for n in sorted(names)]
        else:
            documents = [path.read_bytes()]
        ns = {'k': 'http://www.opengis.net/kml/2.2'}
        features = []
        for document in documents:
            root = ET.fromstring(document)
            for placemark in root.findall('.//k:Placemark', ns):
                props = {'name': placemark.findtext('k:name', default='', namespaces=ns)}
                for data in placemark.findall('.//k:Data', ns):
                    props[data.attrib['name']] = data.findtext('k:value', default='', namespaces=ns)
                for tag in ('LineString', 'Point'):
                    for geom in placemark.findall(f'.//k:{tag}', ns):
                        coords = [[float(c) for c in t.split(',')[:2]] for t in
                                  geom.findtext('k:coordinates', default='', namespaces=ns).split()]
                        features.append({'type': 'Feature', 'properties': props.copy(),
                                         'geometry': {'type': tag, 'coordinates': coords[0] if tag == 'Point' else coords}})
        return features
    document = json.loads(path.read_text())
    if document.get('crs', {}).get('properties', {}).get('name', '') not in (
        '', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'
    ):
        raise ValueError('Reproyecta el GeoJSON a WGS84/EPSG:4326 antes de importarlo.')
    if document['type'] == 'Feature':
        return [document]
    if document['type'] != 'FeatureCollection':
        raise ValueError('Se requiere GeoJSON FeatureCollection o Feature.')
    return document['features']


def _validate_coordinates(geom):
    def visit(value):
        if value and isinstance(value[0], (int, float)):
            if (len(value) < 2 or not all(math.isfinite(c) for c in value)
                    or not (-180 <= value[0] <= 180 and -90 <= value[1] <= 90)):
                raise ValueError('Coordenadas WGS84 inválidas.')
        else:
            for child in value:
                visit(child)
    visit(geom['coordinates'])


def _insert_edge_features(cur, features, source_file, source_url, demo, force_synthetic=False):
    inserted = 0
    for feature in features:
        geom, props = feature['geometry'], feature.get('properties') or {}
        _validate_coordinates(geom)
        if geom['type'] not in ('LineString', 'MultiLineString'):
            raise ValueError('La infraestructura debe contener solo LineString/MultiLineString.')
        synthetic = True if force_synthetic else props.get('synthetic', False)
        if synthetic not in (True, False):
            raise ValueError('synthetic debe ser booleano.')
        if synthetic and not props.get('justification'):
            raise ValueError('Enlace sintético sin justification.')
        if not demo and not (props.get('source') or source_url):
            raise ValueError('Cada enlace necesita source o --source-url con su procedencia.')
        lines = geom['coordinates'] if geom['type'] == 'MultiLineString' else [geom['coordinates']]
        for coordinates in lines:
            line = json.dumps({'type': 'LineString', 'coordinates': coordinates})
            cur.execute(
                """INSERT INTO resiliencia.edges(name,geom,synthetic,provenance)
                   VALUES (%s,ST_Transform(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)),32719),%s,%s)""",
                (
                    props.get('name') or f'Enlace {inserted + 1}',
                    line,
                    synthetic,
                    Jsonb({**props, 'source_file': Path(source_file).name, 'source': props.get('source', source_url)}),
                ),
            )
            inserted += 1
    return inserted


def _rupture_geometry_meters(rupture_doc):
    """Convert USGS rupture MultiPolygon depth_km (Z>0) to elevation meters (Z<0)."""
    features = rupture_doc.get('features', [])
    if not features:
        raise ValueError('El archivo de ruptura USGS no contiene geometrías.')
    geom = features[0]['geometry']
    _validate_coordinates(geom)
    if geom['type'] not in ('Polygon', 'MultiPolygon'):
        raise ValueError('La ruptura USGS debe ser Polygon o MultiPolygon.')
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    converted = [
        [
            [[pt[0], pt[1], -abs(pt[2]) * 1000.0 if len(pt) > 2 else 0.0] for pt in ring]
            for ring in poly
        ]
        for poly in polys
    ]
    return {'type': 'MultiPolygon', 'coordinates': converted}


def build(conn, infrastructure, nodes, earthquake, demo, tolerance, snap_limit, source_url,
          synthetic_links=None, rupture=None):
    features = load_features(infrastructure)
    terminals = load_features(nodes)
    synth_features = load_features(synthetic_links) if synthetic_links and Path(synthetic_links).exists() else []
    with conn.cursor() as cur:
        cur.execute(SCHEMA)
        real_count = _insert_edge_features(cur, features, infrastructure, source_url, demo, force_synthetic=False)
        if not real_count:
            raise ValueError('Infraestructura vacía.')
        synth_count = 0
        if synth_features:
            synth_count = _insert_edge_features(cur, synth_features, synthetic_links, source_url, demo, force_synthetic=True)

        cur.execute('SELECT count(*) FROM resiliencia.edges WHERE ST_IsEmpty(geom) OR ST_NPoints(geom)<2 OR ST_Length(geom)=0 OR NOT ST_IsValid(geom)')
        if cur.fetchone()[0]:
            raise ValueError('Hay enlaces vacíos, inválidos o de longitud cero.')

        cur.execute("SELECT pgr_createTopology('resiliencia.edges',%s,'geom','id','source','target',clean:=true)", (tolerance,))
        if cur.fetchone()[0] != 'OK':
            raise RuntimeError('pgr_createTopology no devolvió OK.')
        cur.execute('SELECT count(*) FROM resiliencia.edges WHERE source IS NULL OR target IS NULL')
        if cur.fetchone()[0]:
            raise RuntimeError('Topología con extremos nulos.')

        for feature in terminals:
            geom, props = feature['geometry'], feature.get('properties') or {}
            _validate_coordinates(geom)
            if geom['type'] != 'Point' or not all(props.get(k) for k in ('name', 'role', 'reference', 'justification')):
                raise ValueError('Cada nodo necesita Point y name, role, reference, justification.')
            cur.execute(
                """INSERT INTO resiliencia.key_nodes(name,role,geom,reference,justification)
                   VALUES (%s,%s,ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)),%s,%s)""",
                (props['name'], props['role'], json.dumps(geom), props['reference'], props['justification']),
            )
        if len(terminals) < 2:
            raise ValueError('Se requieren al menos dos nodos clave.')

        cur.execute("""WITH nearest AS (
            SELECT k.id,v.id AS vertex_id,ST_Distance(k.geom::geography,ST_Transform(v.the_geom,4326)::geography) AS d
            FROM resiliencia.key_nodes k CROSS JOIN LATERAL (
              SELECT id,the_geom FROM resiliencia.edges_vertices_pgr
              ORDER BY the_geom <-> ST_Transform(k.geom,32719) LIMIT 1) v)
            UPDATE resiliencia.key_nodes k SET snap_distance_m=n.d,
            vertex_id=CASE WHEN n.d<=%s THEN n.vertex_id ELSE -k.id END
            FROM nearest n WHERE n.id=k.id""", (snap_limit,))
        cur.execute('SELECT vertex_id FROM resiliencia.key_nodes GROUP BY vertex_id HAVING count(*)>1')
        if cur.fetchall():
            raise ValueError('Nodos clave asociados al mismo vértice. Revisar selección y tolerancia.')
        cur.execute("""INSERT INTO resiliencia.edges_vertices_pgr(id,the_geom)
            SELECT vertex_id,ST_Transform(geom,32719) FROM resiliencia.key_nodes WHERE vertex_id<0""")

        event = load_features(earthquake)
        if len(event) != 1:
            raise ValueError('Se esperaba exactamente un evento USGS.')
        event = event[0]
        if event.get('properties', {}).get('mag') != 8.8 or not str(event.get('id', '')).startswith(('official', 'us', 'usp')):
            raise ValueError('El GeoJSON no corresponde al evento USGS M8.8 esperado.')
        if not 1267200000000 <= event['properties']['time'] < 1267315200000:
            raise ValueError('El evento no corresponde al 27F de 2010.')
        lon, lat, depth = event['geometry']['coordinates']
        rupture_doc = json.loads(Path(rupture).read_text()) if rupture and Path(rupture).exists() else None
        if rupture_doc is not None:
            rupture_geom_m = _rupture_geometry_meters(rupture_doc)
            cur.execute(
                """INSERT INTO resiliencia.earthquake(id,magnitude,depth_km,geom,feature,rupture_geom,rupture_feature)
                   VALUES (%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),%s,
                           ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),%s)""",
                (event['id'], 8.8, depth, lon, lat, Jsonb(event), json.dumps(rupture_geom_m), Jsonb(rupture_doc)),
            )
            cur.execute(
                """UPDATE resiliencia.edges SET distance_km=ST_3DDistance(
                    ST_Force3D(geom,0),
                    ST_Transform((SELECT rupture_geom FROM resiliencia.earthquake LIMIT 1),32719)
                )/1000.0"""
            )
            distance_desc = 'ST_3DDistance en EPSG:32719 (R_rup 3D al plano de ruptura USGS Hayes 2011b, km)'
        else:
            cur.execute(
                """INSERT INTO resiliencia.earthquake(id,magnitude,depth_km,geom,feature)
                   VALUES (%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),%s)""",
                (event['id'], 8.8, depth, lon, lat, Jsonb(event)),
            )
            cur.execute("""UPDATE resiliencia.edges SET distance_km=ST_Distance(
                ST_Transform(geom,4326)::geography,(SELECT geom::geography FROM resiliencia.earthquake))/1000""")
            distance_desc = 'ST_Distance(geography), esferoide WGS84, km'

        settings = dict(
            demo=demo,
            tolerance_m=tolerance,
            snap_limit_m=snap_limit,
            topology='pgr_createTopology; extremos existentes + enlaces sintéticos declarados; sin empalmes inferidos en cruces',
            srid=32719,
            distance=distance_desc,
            distance_metric='R_rup' if rupture_doc is not None else 'epicenter',
            source_url=source_url,
            baseline_p_failure=0,
            real_edges=real_count,
            synthetic_edges=synth_count,
            synthetic_file=Path(synthetic_links).name if synth_count else None,
            rupture_file=Path(rupture).name if rupture_doc is not None else None,
        )
        cur.execute('INSERT INTO resiliencia.metadata VALUES (%s,%s)', ('settings', Jsonb(settings)))
    conn.commit()


def update_probabilities(conn, site='soil', median_pga=0.33, beta=0.20, z_t=0):
    """Apply Youngs et al. (1997) PGA + FEMA HAZUS-MH fragility to every edge in PostGIS."""
    with conn.cursor() as cur:
        cur.execute('SELECT magnitude, depth_km, rupture_geom IS NOT NULL FROM resiliencia.earthquake LIMIT 1')
        magnitude, depth_km, has_rupture = cur.fetchone()
        cur.execute('SELECT id, distance_km FROM resiliencia.edges ORDER BY id')
        updates = []
        for edge_id, distance_km in cur.fetchall():
            pga = pga_youngs1997(
                distance_km,
                magnitude=magnitude,
                depth_km=depth_km,
                site=site,
                z_t=z_t,
                is_rupture_distance=bool(has_rupture),
            )
            p_fail = fragility_hazus(pga, median_pga=median_pga, beta=beta)
            updates.append((pga, p_fail, edge_id))
        cur.executemany('UPDATE resiliencia.edges SET pga_g=%s, p_failure=%s WHERE id=%s', updates)
    conn.commit()


def rows(conn, query, params=()):
    with conn.cursor() as cur:
        cur.execute(query, params)
        names = [c.name for c in cur.description]
        return [dict(zip(names, row)) for row in cur.fetchall()]


def export_sql(conn, target):
    """Export isolated schema `resiliencia` with topology, key nodes, earthquake and probabilities."""
    tables = ['edges', 'edges_vertices_pgr', 'key_nodes', 'earthquake', 'metadata']
    chunks = [
        '-- Resiliencia de Internet en Chile: export reproducible (PostGIS + pgRouting + modelo Youngs 1997 / HAZUS-MH).\nBEGIN;\n',
        SCHEMA,
        'CREATE TABLE resiliencia.edges_vertices_pgr(id bigint PRIMARY KEY,cnt integer,chk integer,ein integer,eout integer,the_geom geometry(Point,32719));\n',
    ]
    for table in tables:
        with conn.cursor() as cur:
            cur.execute(sql.SQL('SELECT * FROM resiliencia.{} ORDER BY 1').format(sql.Identifier(table)))
            columns = [c.name for c in cur.description]
            for row in cur:
                values = [Jsonb(v) if isinstance(v, (dict, list)) else v for v in row]
                statement = sql.SQL('INSERT INTO resiliencia.{} ({}) VALUES ({});\n').format(
                    sql.Identifier(table),
                    sql.SQL(',').join(map(sql.Identifier, columns)),
                    sql.SQL(',').join(sql.Literal(v) for v in values),
                )
                chunks.append(statement.as_string(conn))
    for table in ['edges', 'key_nodes']:
        chunks.append(f"SELECT setval(pg_get_serial_sequence('resiliencia.{table}','id'),COALESCE((SELECT max(id) FROM resiliencia.{table}),1),true);\n")
    chunks.append('CREATE INDEX ON resiliencia.edges USING gist(geom);\nCREATE INDEX ON resiliencia.edges_vertices_pgr USING gist(the_geom);\nCOMMIT;\n')
    Path(target).write_text(''.join(chunks))
