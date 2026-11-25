# Visor Web · Resiliencia de Internet en Chile (27F)

Interfaz interactiva desarrollada con **Next.js (App Router)**, **TypeScript**, **shadcn/ui** (estilos base), **Leaflet** y **Bun**.

## Estructura

- `src/app/page.tsx`: página principal.
- `src/app/globals.css`: tokens base de `shadcn/ui` y reglas estructurales del layout a pantalla completa.
- `src/app/api/output/[...path]/route.ts`: Route Handler que expone `results.json`, `edges.geojson`, `nodes.geojson`, `earthquake.geojson`, `topology.json` y capas de contexto generados en `../output`.
- `src/components/dashboard.tsx`: panel flotante compactable con tarjetas de ATTR, controles de escenario, selector de capas y acordeones de evidencia.
- `src/components/resilience-map.tsx`: mapa Leaflet client-side a pantalla completa con filtro monocromático, enlaces coloreados por probabilidad de falla, enlaces sintéticos punteados, 12 nodos clave y epicentro USGS M 8.8.
- `src/components/ui/`: componentes base instalados con el CLI de `shadcn/ui`.

## Ejecución local con Bun

```bash
bun install
bun run dev -- --port 8082
```

En producción dentro de Docker (`oven/bun:1`), el contenedor se compila y levanta automáticamente al ejecutar `python3 main.py` desde la raíz del repositorio.
