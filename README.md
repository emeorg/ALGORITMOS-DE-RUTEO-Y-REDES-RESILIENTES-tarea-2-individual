# Resiliencia de la Internet Chilena ante el 27F (M 8.8)

Evaluación probabilística de la conectividad de la infraestructura troncal de fibra óptica de Chile frente al terremoto del Maule del 27 de febrero de 2010 ($M_w = 8.8$). El proyecto importa el levantamiento oficial de SUBTEL/Yafün, construye la topología de red con `pgr_createTopology`, integra el sismo desde USGS, aplica un modelo sísmico publicado en literatura (**Youngs et al., 1997** + **FEMA HAZUS-MH**), calcula el **ATTR** antes y después del evento, exporta `main.sql` y levanta un visor interactivo en **Leaflet**.

---

## Ejecución con un solo comando

Requisitos del equipo: **Docker Engine con Compose v2** y **Python 3.10+** (la primera ejecución requiere conexión a Internet para descargar las imágenes Docker y las teselas OpenStreetMap del mapa).

```bash
python3 main.py
```

Con ese único comando, `main.py`:
1. Inicia PostgreSQL + PostGIS + pgRouting (`pgrouting/pgrouting:16-3.5-3.8`) en un contenedor aislado (`resiliencia-internet-cl`).
2. Construye los contenedores `app` (`python:3.12-slim`) y `web` (`oven/bun:1` con Next.js + `shadcn/ui`).
3. Carga `main.sql` en el esquema `resiliencia` (o reconstruye toda la topología desde `Respuesta_T5610.zip` y descarga el evento + ShakeMap oficial del USGS si `main.sql` no existe o se indica `--rebuild`).
4. Calcula el **ATTR en operación** ($p_{\text{falla}} = 0$).
5. Calcula la aceleración sísmica ($\text{PGA}$) y la probabilidad de falla de cada enlace usando la distancia 3D ($R_{\text{rup}}$) al plano de ruptura oficial del USGS (`official20100227063411530_30` / *Hayes 2011b*) y actualiza `resiliencia.edges`.
6. Calcula el **ATTR post-terremoto 27F** (Monte Carlo, $N = 20.000$, semilla `27`), exporta `output/results.json`, capas GeoJSON (incluido `shakemap.geojson` y `rupture.geojson`) y `main.sql`.
7. Levanta el visor **Next.js + `shadcn/ui` + Leaflet** ejecutado con **Bun** en **http://localhost:8082** (Ctrl+C detiene el servidor; `docker compose stop` detiene la BD conservando sus datos).

Para cambiar el puerto local:

```bash
APP_PORT=8083 python3 main.py
```

### Opciones útiles

```bash
# Reconstruir desde los archivos originales ejecutando pgr_createTopology y sensibilidad
python3 main.py --rebuild --sensitivity

# Calcular y exportar sin levantar el servidor web
python3 main.py --no-serve

# Evaluar solo la capa SAIP pura sin enlaces sintéticos declarados
python3 main.py --rebuild --no-synthetic --no-serve

# Desarrollo local del visor web con Bun (tras generar output/)
cd web && bun install && bun run dev -- --port 8082

# Ejecutar usando Python, Bun y PostgreSQL locales (PostGIS + pgRouting 3.8)
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
DATABASE_URL=postgresql://usuario:clave@localhost:5432/resiliencia .venv/bin/python main.py --native
```

---

## Dependencias y librerías utilizadas

| Componente / Librería | Versión | Uso en el proyecto |
|---|---|---|
| `pgrouting/pgrouting` (Docker) | `16-3.5-3.8` | PostgreSQL 16 + PostGIS 3.5 + pgRouting 3.8. Se fija pgRouting 3.8 porque expone `pgr_createTopology` y `pgr_connectedComponents`. |
| `psycopg[binary]` | `3.2.6` | Driver oficial de Python para PostgreSQL/PostGIS: ejecuta SQL espacial, `pgr_createTopology`, carga/exportación de `main.sql` y lectura de resultados. |
| `numpy` | `2.2.4` | Generación vectorizada de números aleatorios reproducibles (`default_rng(27)`) y cálculo de estadísticos (media, error estándar, IC 95 %) en la simulación Monte Carlo del ATTR. |
| `pyshp` (`shapefile`) | `2.3.1` | Lectura directa de los shapefiles originales (`fibra_optica_detectada.shp` y capas de contexto) contenidos en `Respuesta_T5610.zip` sin depender de GDAL nativo. |
| `Bun` (`oven/bun:1` en Docker) | `1.3.x` | Runtime JavaScript/TypeScript y gestor de paquetes rápido para instalar, compilar y servir la aplicación Next.js (`bun run start`). |
| `Next.js` + `React` | `16.x` / `19.x` | Estructura App Router (`web/src/app/`) y Route Handler `/api/output/[...path]` para servir en vivo los JSON/GeoJSON exportados por `main.py`. |
| `shadcn/ui` + `@base-ui/react` + `Tailwind CSS` | `4.x` | Componentes de interfaz con estilos base (`Card`, `Badge`, `Tabs`, `Slider`, `Switch`, `Select`, `Command`, `Kbd`, `Label`, `Accordion`, `Table`, `Alert`, `ScrollArea`, `Separator`, `Button`) para paneles flotantes, tema claro/oscuro/sistema y atajos de teclado (`Ctrl + h`). |
| `lucide-react` + `cmdk` | `1.x` | Iconografía vectorial de controles y paleta buscable de atajos de teclado (`Ctrl + h`, `Ctrl + ←`, `Ctrl + ↓`, `Ctrl + +`, `Ctrl + -`). |
| `Leaflet` | `1.9.4` | Mapa interactivo a pantalla completa: fibra SAIP coloreada por probabilidad de falla, enlaces sintéticos declarados (trazo punteado), nodos clave, epicentro USGS, bandas translúcidas del USGS ShakeMap (`MMI 4.0–7.5`), selector de mapa base y geolocalización. |
| `pytest` *(solo pruebas)* | `8.3.5` | Ejecución de las 17 pruebas unitarias en `tests/` (ATTR exacto vs. Monte Carlo, atenuación Youngs 1997, fragilidad HAZUS, validación SAIP y USGS). |

---

## Resumen de resultados verificados

| Métrica | Valor | Detalle |
|---|---:|---|
| **Infraestructura observada (SAIP)** | **1.915 enlaces** (~10.312,8 km) | Capa `fibra_optica_detectada.shp` (168 componentes aisladas en el dato puro). |
| **Enlaces sintéticos declarados** | **31 enlaces** (~2.127,0 km) | Marcados `synthetic = true` en BD y línea punteada en Leaflet (`data/enlaces_sinteticos.geojson`). |
| **Topología integrada (`pgr_createTopology`)** | **1.946 enlaces / 2.079 vértices** | Tolerancia 10 m en `EPSG:32719`, 12 nodos clave asociados (0 aislados). |
| **ATTR en operación ($p_{\text{falla}} = 0$)** | **1,0000 (100,00 %)** | Método exacto (los 12 nodos clave quedan en la componente troncal nacional). |
| **ATTR post-terremoto 27F ($M_w = 8.8$)** | **0,1123 (11,23 %)** | Monte Carlo ($N = 20.000$, semilla `27`), IC 95 %: `[11,18 % – 11,27 %]`, SE = `0,00021`. |
| **Variación de conectividad** | **−0,8877 (−88,77 pts)** | Caída total en Concepción, Talca y Rancagua (`0,00 %`), Temuco/Pto. Montt (`1,07 %`), Santiago (`14,06 % – 14,27 %`) y Valparaíso (`17,57 %`); sensibilidad 6 escenarios: `11,23 % – 43,02 %`. |

---

## Fuentes de datos y decisiones metodológicas

### 1. Infraestructura y nodos clave
- **Fibra observada:** `Respuesta_T5610.zip` (SAIP AN002T0005610, ORD. 7479/G del 29-05-2023, proyecto Yafün / [Estudio SUBTEL – NIC Labs, 2018](https://www.subtel.gob.cl/wp-content/uploads/2018/12/resiliencia_uchile_corfo_subtel.pdf)). El archivo contiene ~10.312,8 km de fibra óptica (coincidente con los 10.342 km del Cuadro 4.1 del Estudio, frente a ~26.534 km totales recorridos incluyendo postación eléctrica, caminos sin postación y ferrys). Las otras tres capas se exportan solo como contexto visual.
- **Nodos clave (`data/nodos_clave.geojson`):** 12 nodos que cubren aterrizajes de cables submarinos (**Arica** y **Valparaíso**, TeleGeography SAm-1/SAC), IXP/PIT y data centers de **Santiago** (**Cirion SAN1**, **Torre Entel**, **Equinix ST1/ST2**, PeeringDB registrados antes de 2019) y nodos troncales regionales (**Antofagasta**, **La Serena**, **Rancagua**, **Talca**, **Concepción**, **Temuco**, **Puerto Montt**, Estudio SUBTEL 2018).
- **Enlaces sintéticos declarados (`data/enlaces_sinteticos.geojson`):** El levantamiento visual SAIP presenta 168 componentes desconectadas y omite la fibra urbana soterrada (p. ej. el propio Estudio SUBTEL en la sección 6.2, Supuesto S2, declara que no validó en terreno el Gran Santiago). Para evaluar conectividad troncal nacional sin ocultar la limitación del dato, se agregan **31 enlaces sintéticos** explícitamente marcados (`synthetic = true`) y justificados individualmente: acometidas urbanas a los nodos clave, anillo metropolitano de Santiago (Supuesto S2), cierres de brechas urbanas/soterradas en Ruta 5 y el cable submarino SAm-1 entre Arica y Valparaíso (operativo desde 2001).

### 2. Topología (`pgr_createTopology`) y distancias 3D
- `pgr_createTopology('resiliencia.edges', 10, 'geom', 'id', 'source', 'target', clean:=true)` sobre `EPSG:32719` con tolerancia de **10 metros** para unificar extremos con pequeñas diferencias cartográficas sin fusionar trazados paralelos ni crear empalmes ficticios en cruces.
- Las distancias enlace–ruptura ($R_{\text{rup}}$, `distance_km`) se calculan en PostGIS en 3D con `ST_3DDistance(ST_Force3D(geom, 0), ST_Transform(rupture_geom, 32719)) / 1000.0` (en metros convertidos a km sobre `EPSG:32719`) respecto del plano inclinado de ruptura oficial del USGS (*Hayes 2011b*, de `2,86 km` de profundidad en la fosa hasta `52,31 km` tierra adentro).

### 3. Sismo 27F y modelo de falla probabilístico
- **Evento sísmico y ShakeMap oficial (`data/raw/terremoto_27f.geojson`, `rupture_27f.geojson`, `shakemap_mmi_27f.geojson`):** Descargados vía API FDSNWS de USGS (`official20100227063411530_30`, 27-02-2010, $M_w = 8.8$, profundidad $H = 22.9\text{ km}$, epicentro `-72.898, -36.122`, falla finita de ~500 km y contornos MMI del ShakeMap) y cargados en `resiliencia.earthquake`.
- **Etapa 1 — Ecuación de atenuación de PGA (GMPE):** **Youngs et al. (1997)**, *"Strong Ground Motion Attenuation Relationships for Subduction Zone Earthquakes"*, *Seismological Research Letters*, 68(1), 58–73 ([DOI: 10.1785/gssrl.68.1.58](https://doi.org/10.1785/gssrl.68.1.58)), para eventos de subducción interplaca ($Z_T = 0$) en sitio de suelo (`soil`):
  $$\ln(\text{PGA}) = -0.6687 + 1.438\,M_w - 2.329\ln\!\left(R_{\text{rup}} + 1.097\,e^{0.617\,M_w}\right) + 0.00648\,H + 0.3643\,Z_T$$
  donde $R_{\text{rup}}$ (km) es la distancia 3D más cercana desde el enlace hasta la superficie de ruptura finita del USGS (`rupture_27f.geojson`) y $\text{PGA}$ se obtiene en unidades de $g$.
- **Etapa 2 — Curva de fragilidad lognormal:** **FEMA HAZUS-MH Earthquake Model Technical Manual** (Cap. 8, *Direct Damage to Lifeline Utility Systems* — *Distribution Circuits, Standard Components*):
  $$p_{\text{falla}}(e) = \Phi\!\left(\frac{\ln(\text{PGA}(e) / A_m)}{\beta}\right), \quad A_m = 0.30\,g,\ \beta = 0.50$$
  **Justificación para fibra óptica chilena:** Según el Cuadro 4.1 del Estudio SUBTEL (2018), el **98,3 %** de la fibra óptica validada en terreno en Chile (10.164 de 10.342 km) es **tendido aéreo sobre postación eléctrica** (y solo 1,7 % es soterrada), con deficiencias de instalación documentadas en el Anexo 9.5; en consecuencia, la fragilidad de circuitos aéreos sobre postes refleja directamente el mecanismo dominante de falla física de los enlaces.

### 4. Métrica ATTR
Para un conjunto $K$ de $k = 12$ nodos clave ($\binom{12}{2} = 66$ pares distintos), se define según **Boettcher et al. (2018)** (Ec. 8, [DOI: 10.1109/TLA.2018.8789553](https://doi.org/10.1109/TLA.2018.8789553)) y **Manzano et al. (2016)** ([DOI: 10.1007/s10922-016-9391-y](https://doi.org/10.1007/s10922-016-9391-y)):
$$\text{ATTR}(K) = \frac{1}{\binom{|K|}{2}} \sum_{\{u, v\} \subset K} P(u \leftrightarrow v)$$
El cálculo utiliza enumeración exacta hasta 16 enlaces inciertos y simulación Monte Carlo con $N = 20.000$ realizaciones (semilla `27`) en caso contrario; por desigualdad de Hoeffding al 95 %, el error máximo de muestreo está acotado a $\pm 0,00960$, y el error estándar empírico observado entre realizaciones es `0,00021`.

---

## Verificación y pruebas

```bash
# Pruebas unitarias (17 tests)
.venv/bin/python -m pytest -v

# Ejecución completa sin servidor (carga main.sql y verifica reproducibilidad)
python3 main.py --no-serve
```
