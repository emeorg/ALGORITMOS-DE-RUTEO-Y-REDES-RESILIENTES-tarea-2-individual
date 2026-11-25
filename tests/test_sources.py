import json
from pathlib import Path
import pytest
from src.database import load_features
from src.sources import prepare_saip

ROOT = Path(__file__).resolve().parents[1]


def test_original_zip_layers_preserved(tmp_path):
    layers = prepare_saip(ROOT / 'Respuesta_T5610.zip', tmp_path)
    assert len(layers) == 4
    fiber = load_features(layers['fibra_optica_detectada'])
    assert len(fiber) == 1915
    assert all(f['properties']['synthetic'] is False for f in fiber)
    assert all(f['properties']['layer'] == 'fibra_optica_detectada' for f in fiber)


def test_usgs_event_identity():
    event = load_features(ROOT / 'data/raw/terremoto_27f.geojson')[0]
    assert event['properties']['mag'] == 8.8
    assert event['geometry']['coordinates'][:2] == [-72.898, -36.122]


def test_key_nodes_and_synthetic_links_documented():
    nodes = load_features(ROOT / 'data/nodos_clave.geojson')
    assert len(nodes) == 12
    for n in nodes:
        props = n['properties']
        assert all(props.get(k) for k in ('name', 'role', 'reference', 'justification'))
    synth = load_features(ROOT / 'data/enlaces_sinteticos.geojson')
    assert len(synth) >= 20
    for e in synth:
        props = e['properties']
        assert props.get('synthetic') is True
        assert props.get('justification') and props.get('source')


def test_kml_multi_geometry(tmp_path):
    path = tmp_path / 'input.kml'
    path.write_text(
        '''<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Fibra</name><MultiGeometry><LineString><coordinates>-71,-33,0 -72,-34,0</coordinates></LineString><LineString><coordinates>-72,-34,0 -73,-35,0</coordinates></LineString></MultiGeometry></Placemark></Document></kml>'''
    )
    assert len(load_features(path)) == 2


def test_projected_geojson_is_rejected(tmp_path):
    path = tmp_path / 'input.geojson'
    path.write_text(json.dumps(dict(type='FeatureCollection', features=[], crs=dict(properties=dict(name='EPSG:3857')))))
    with pytest.raises(ValueError):
        load_features(path)
