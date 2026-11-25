"""Convert the original SAIP ZIP, preserving all layers and their provenance."""
import io
import json
from urllib.request import urlopen
import zipfile
from pathlib import Path
import shapefile

USGS_URL = ('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson'
            '&starttime=2010-02-27&endtime=2010-02-28&minmagnitude=8'
            '&maxlatitude=-30&minlatitude=-40&minlongitude=-80&maxlongitude=-65')
USGS_DETAIL_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=official20100227063411530_30&format=geojson'
STUDY_URL = 'https://www.subtel.gob.cl/wp-content/uploads/2018/12/resiliencia_uchile_corfo_subtel.pdf'
GMPE_PAPER_URL = 'https://doi.org/10.1785/gssrl.68.1.58'
HAZUS_URL = 'https://www.fema.gov/flood-maps/products-tools/hazus'
ATTR_BOETTCHER_URL = 'https://doi.org/10.1109/TLA.2018.8789553'
ATTR_MANZANO_URL = 'https://doi.org/10.1007/s10922-016-9391-y'


def ensure_usgs_shakemap(rupture_path, contours_path):
    """Download official USGS ShakeMap finite-fault rupture and MMI contours if missing."""
    rupture_path = Path(rupture_path)
    contours_path = Path(contours_path)
    if rupture_path.exists() and contours_path.exists():
        return
    rupture_path.parent.mkdir(parents=True, exist_ok=True)
    contours_path.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(USGS_DETAIL_URL, timeout=45) as response:
        detail = json.loads(response.read())
    shakemaps = detail.get('properties', {}).get('products', {}).get('shakemap', [])
    if not shakemaps:
        raise ValueError('El evento USGS no incluye producto shakemap.')
    contents = shakemaps[0].get('contents', {})
    if not rupture_path.exists():
        with urlopen(contents['download/rupture.json']['url'], timeout=45) as resp:
            rupture_path.write_bytes(resp.read())
    if not contours_path.exists():
        with urlopen(contents['download/cont_mmi.json']['url'], timeout=45) as resp:
            contours_path.write_bytes(resp.read())


def prepare_saip(archive_path, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    layers = {}
    with zipfile.ZipFile(archive_path) as archive:
        for shp in sorted(n for n in archive.namelist() if n.endswith('.shp')):
            base = shp[:-4]
            projection = archive.read(base + '.prj').decode()
            if 'WGS_1984' not in projection and 'WGS 84' not in projection:
                raise ValueError('Proyección SAIP inesperada: se requiere WGS84.')
            reader = shapefile.Reader(
                shp=io.BytesIO(archive.read(shp)),
                shx=io.BytesIO(archive.read(base + '.shx')),
                dbf=io.BytesIO(archive.read(base + '.dbf')),
                encoding='latin1',
            )
            layer = Path(base).name
            features = []
            for record in reader.iterShapeRecords():
                rec_id = record.record.as_dict()['id']
                features.append(dict(
                    type='Feature',
                    geometry=record.shape.__geo_interface__,
                    properties=dict(
                        name=f'{layer} {rec_id}',
                        source='SUBTEL, SAIP AN002T0005610, ORD. 7479/G, 29-05-2023',
                        layer=layer,
                        original_id=str(rec_id),
                        synthetic=False,
                    ),
                ))
            output = destination / f'{layer}.geojson'
            output.write_text(json.dumps(dict(type='FeatureCollection', features=features), ensure_ascii=False))
            layers[layer] = output
    if 'fibra_optica_detectada' not in layers:
        raise ValueError('El ZIP no contiene fibra_optica_detectada.shp.')
    return layers
