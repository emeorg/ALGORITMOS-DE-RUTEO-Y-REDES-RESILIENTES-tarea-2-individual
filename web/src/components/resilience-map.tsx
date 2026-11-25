"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import type { FeatureCollection } from "geojson";
import type {
  EarthquakeFeature,
  EdgeProperties,
  KeyNodeResult,
  LayerVisibility,
  MapStyleId,
} from "@/lib/types";

export interface UserLocation {
  lat: number;
  lon: number;
  accuracy: number;
}

export interface MapController {
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  showUserLocation(location: UserLocation): void;
  clearUserLocation(): void;
}

const INITIAL_CENTER: [number, number] = [-34.7, -71.8];
const INITIAL_ZOOM = 5;

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

interface MapStyleSpec {
  url: string;
  attribution: string;
  maxZoom: number;
}

const MAP_STYLES: Record<MapStyleId, MapStyleSpec> = {
  minimal: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  },
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)",
    maxZoom: 17,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics",
    maxZoom: 18,
  },
};

interface ResilienceMapProps {
  edges: FeatureCollection;
  nodes: FeatureCollection;
  earthquake: EarthquakeFeature;
  shakemap: FeatureCollection | null;
  mode: "damage" | "baseline";
  threshold: number;
  layers: LayerVisibility;
  mapStyle: MapStyleId;
  onMapReady?: (controller: MapController | null) => void;
}

const CONTEXT_LAYERS: Array<{
  key: keyof Pick<
    LayerVisibility,
    "contextPostacion" | "contextCaminos" | "contextFerry"
  >;
  file: string;
  color: string;
}> = [
  {
    key: "contextPostacion",
    file: "postacion_electrica_detectada.geojson",
    color: "#78716c",
  },
  {
    key: "contextCaminos",
    file: "camino_sin_postacion_detectado.geojson",
    color: "#a16207",
  },
  {
    key: "contextFerry",
    file: "trayecto_en_ferry.geojson",
    color: "#0369a1",
  },
];

function percent(value: number): string {
  return `${(value * 100).toFixed(2)} %`;
}

function failureColor(p: number): string {
  if (p < 0.05) return "#16a34a";
  if (p < 0.15) return "#84cc16";
  if (p < 0.3) return "#eab308";
  if (p < 0.45) return "#f97316";
  return "#dc2626";
}

interface PopupMetric {
  label: string;
  value: string;
  tone?: "default" | "impact";
}

interface PopupSpec {
  badges?: string[];
  title: string;
  subtitle?: string;
  metrics?: PopupMetric[];
  description?: string;
  link?: { label: string; href: string };
}

function cleanText(text: string): string {
  return text
    .replace(/\s*\(([^)]+)\)/g, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (/^\d{4}/.test(trimmed)) return ` ${trimmed}`;
      return `, ${trimmed}`;
    })
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/,\s*;/g, ";")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatRole(role: string): string {
  return role
    .split("/")
    .map((part) => {
      const t = part.trim();
      return t ? t[0].toUpperCase() + t.slice(1) : "";
    })
    .filter(Boolean)
    .join(" · ");
}

function formatSourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host.includes("submarinecablemap.com")) return "TeleGeography";
    if (host.includes("subtel.gob.cl")) return "Estudio SUBTEL 2018";
    if (host.includes("peeringdb.com")) {
      const fac = parsed.pathname.split("/").filter(Boolean).pop();
      return fac ? `PeeringDB · #${fac}` : "PeeringDB";
    }
    if (host.includes("earthquake.usgs.gov")) return "Ficha sísmica USGS";
    return host;
  } catch {
    return "Fuente";
  }
}

function createExternalLinkIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const paths = [
    "M15 3h6v6",
    "M10 14 21 3",
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  ];
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function buildPopupCard(spec: PopupSpec): HTMLElement {
  const card = document.createElement("div");
  card.dataset.popup = "card";

  if (spec.badges && spec.badges.length > 0) {
    const badgesRow = document.createElement("div");
    badgesRow.dataset.popup = "badges";
    spec.badges.forEach((label, idx) => {
      const badge = document.createElement("span");
      badge.dataset.popup = idx === 0 ? "badge-primary" : "badge-secondary";
      badge.textContent = label;
      badgesRow.appendChild(badge);
    });
    card.appendChild(badgesRow);
  }

  const header = document.createElement("div");
  header.dataset.popup = "header";
  const heading = document.createElement("h3");
  heading.dataset.popup = "title";
  heading.textContent = spec.title;
  header.appendChild(heading);

  if (spec.subtitle) {
    const sub = document.createElement("p");
    sub.dataset.popup = "subtitle";
    sub.textContent = spec.subtitle;
    header.appendChild(sub);
  }
  card.appendChild(header);

  if (spec.metrics && spec.metrics.length > 0) {
    const grid = document.createElement("div");
    grid.dataset.popup = "metrics";
    grid.dataset.cols = String(Math.min(spec.metrics.length, 3));
    for (const metric of spec.metrics) {
      const item = document.createElement("div");
      item.dataset.popup = "metric";
      const label = document.createElement("span");
      label.dataset.popup = "metric-label";
      label.textContent = metric.label;
      const value = document.createElement("span");
      value.dataset.popup = "metric-value";
      if (metric.tone === "impact") {
        value.dataset.tone = "impact";
      }
      value.textContent = metric.value;
      item.appendChild(label);
      item.appendChild(value);
      grid.appendChild(item);
    }
    card.appendChild(grid);
  }

  if (spec.description) {
    const desc = document.createElement("p");
    desc.dataset.popup = "description";
    desc.textContent = spec.description;
    card.appendChild(desc);
  }

  if (spec.link) {
    const footer = document.createElement("div");
    footer.dataset.popup = "footer";
    const anchor = document.createElement("a");
    anchor.dataset.popup = "link";
    anchor.href = spec.link.href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = spec.link.label;
    anchor.appendChild(createExternalLinkIcon());
    footer.appendChild(anchor);
    card.appendChild(footer);
  }

  return card;
}

export function ResilienceMap({
  edges,
  nodes,
  earthquake,
  shakemap,
  mode,
  threshold,
  layers,
  mapStyle,
  onMapReady,
}: ResilienceMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const realLayerRef = useRef<L.GeoJSON | null>(null);
  const synthLayerRef = useRef<L.GeoJSON | null>(null);
  const nodesLayerRef = useRef<L.GeoJSON | null>(null);
  const epicenterLayerRef = useRef<L.LayerGroup | null>(null);
  const shakemapLayerRef = useRef<L.LayerGroup | null>(null);
  const userLocationLayerRef = useRef<L.LayerGroup | null>(null);
  const contextLayersRef = useRef<Record<string, L.GeoJSON>>({});

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      preferCanvas: true,
    }).setView(INITIAL_CENTER, INITIAL_ZOOM);

    const spec = MAP_STYLES.minimal;
    tileLayerRef.current = L.tileLayer(spec.url, {
      attribution: spec.attribution,
      maxZoom: spec.maxZoom,
    }).addTo(map);

    L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);

    const bindEdgePopup = (feature: GeoJSON.Feature, layer: L.Layer) => {
      const props = feature.properties as EdgeProperties;
      let badges: string[];
      let title: string;

      if (props.synthetic) {
        const colonIdx = props.name.indexOf(": ");
        if (colonIdx > 0) {
          badges = ["Enlace sintético", cleanText(props.name.slice(0, colonIdx))];
          title = cleanText(props.name.slice(colonIdx + 2));
        } else {
          badges = ["Enlace sintético"];
          title = cleanText(props.name);
        }
      } else {
        badges = ["Fibra SAIP"];
        const saipMatch = /^fibra_optica_detectada\s+(\d+)$/i.exec(props.name);
        title = saipMatch
          ? `Tramo de fibra #${saipMatch[1]}`
          : cleanText(props.name.replaceAll("_", " "));
      }

      const metrics: PopupMetric[] = [
        {
          label: "Falla",
          value: percent(props.p_failure),
          tone: props.p_failure >= 0.3 ? "impact" : "default",
        },
      ];
      if (props.pga_g != null) {
        metrics.push({ label: "PGA", value: `${props.pga_g.toFixed(3)} g` });
      }
      metrics.push({
        label: "A la ruptura",
        value: `${props.distance_km.toFixed(1)} km`,
      });

      layer.bindPopup(
        buildPopupCard({
          badges,
          title,
          metrics,
          description:
            props.synthetic && props.justification
              ? cleanText(props.justification)
              : undefined,
        }),
        { maxWidth: 320 }
      );
    };

    const realCollection: FeatureCollection = {
      type: "FeatureCollection",
      features: edges.features.filter(
        (f) => !(f.properties as EdgeProperties).synthetic
      ),
    };
    const synthCollection: FeatureCollection = {
      type: "FeatureCollection",
      features: edges.features.filter(
        (f) => (f.properties as EdgeProperties).synthetic
      ),
    };

    const realLayer = L.geoJSON(realCollection, {
      onEachFeature: bindEdgePopup,
    });
    const synthLayer = L.geoJSON(synthCollection, {
      onEachFeature: bindEdgePopup,
    });

    const nodesLayer = L.geoJSON(nodes, {
      pointToLayer: (feature, latlng) => {
        const props = feature.properties as KeyNodeResult;
        return L.circleMarker(latlng, {
          radius: 6.5,
          color: props.unmatched ? "#b45309" : "#171717",
          fillColor: "#ffffff",
          weight: 2.2,
          fillOpacity: 1,
        });
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties as KeyNodeResult;
        const [rawTitle, rawSubtitle] = props.name.split(" — ");
        layer.bindPopup(
          buildPopupCard({
            badges: [
              formatRole(props.role),
              props.unmatched ? "Sin conexión" : `Vértice ${props.vertex_id}`,
            ],
            title: cleanText(rawTitle),
            subtitle: rawSubtitle ? cleanText(rawSubtitle) : undefined,
            metrics: props.unmatched
              ? undefined
              : [
                  {
                    label: "Conectividad antes",
                    value: percent(props.connectivity_before),
                  },
                  {
                    label: "Conectividad después",
                    value: percent(props.connectivity_after),
                    tone: props.connectivity_after < 0.5 ? "impact" : "default",
                  },
                ],
            description: cleanText(props.justification),
            link: props.reference
              ? {
                  label: formatSourceLabel(props.reference),
                  href: props.reference,
                }
              : undefined,
          }),
          { maxWidth: 320 }
        );
      },
    });

    const [epiLon, epiLat, epiDepth] = earthquake.geometry.coordinates;
    const usgsUrl = `https://earthquake.usgs.gov/earthquakes/eventpage/${earthquake.id}/executive`;
    const epicenterHalo = L.circleMarker([epiLat, epiLon], {
      radius: 15,
      stroke: false,
      fillColor: "#ef4444",
      fillOpacity: 0.26,
      interactive: false,
    });
    const epicenterDot = L.circleMarker([epiLat, epiLon], {
      radius: 7.5,
      color: "#ffffff",
      weight: 2.2,
      fillColor: "#dc2626",
      fillOpacity: 1,
    }).bindPopup(
      buildPopupCard({
        badges: ["Epicentro USGS", "27 feb 2010"],
        title: "Terremoto del Maule",
        metrics: [
          {
            label: "Magnitud",
            value: `M ${earthquake.properties.mag} mww`,
            tone: "impact",
          },
          {
            label: "Profundidad",
            value: `${epiDepth} km`,
          },
        ],
        description: `Coordenadas ${epiLat.toFixed(3)}°, ${epiLon.toFixed(3)}°`,
        link: {
          label: "Ficha sísmica USGS",
          href: usgsUrl,
        },
      }),
      { maxWidth: 320 }
    );
    const epicenterLayer = L.layerGroup([epicenterHalo, epicenterDot]);

    const SHAKEMAP_BANDS: Record<
      number,
      {
        color: string;
        fillColor: string;
        fillOpacity: number;
        opacity: number;
        weight: number;
        dashArray: string;
      }
    > = {
      4: {
        color: "#fb923c",
        fillColor: "#fb923c",
        fillOpacity: 0.045,
        opacity: 0.32,
        weight: 1,
        dashArray: "4 6",
      },
      5: {
        color: "#f97316",
        fillColor: "#f97316",
        fillOpacity: 0.06,
        opacity: 0.42,
        weight: 1.1,
        dashArray: "4 5",
      },
      6: {
        color: "#ea580c",
        fillColor: "#ea580c",
        fillOpacity: 0.08,
        opacity: 0.5,
        weight: 1.2,
        dashArray: "4 5",
      },
      7: {
        color: "#ef4444",
        fillColor: "#dc2626",
        fillOpacity: 0.11,
        opacity: 0.62,
        weight: 1.3,
        dashArray: "4 4",
      },
      7.5: {
        color: "#dc2626",
        fillColor: "#b91c1c",
        fillOpacity: 0.16,
        opacity: 0.74,
        weight: 1.4,
        dashArray: "4 4",
      },
    };

    const shakemapLayer = (() => {
      if (!shakemap) return null;
      const polygons: L.Polygon[] = [];
      const sorted = [...shakemap.features].sort(
        (a, b) =>
          Number((a.properties as { value?: number } | null)?.value ?? 0) -
          Number((b.properties as { value?: number } | null)?.value ?? 0)
      );
      for (const feature of sorted) {
        const value = Number(
          (feature.properties as { value?: number } | null)?.value ?? 0
        );
        const style = SHAKEMAP_BANDS[value];
        if (!style || feature.geometry.type !== "MultiLineString") continue;
        for (const ring of feature.geometry.coordinates) {
          if (ring.length < 10) continue;
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) continue;
          const latlngs = ring.map(([lon, lat]) => [lat, lon] as [number, number]);
          polygons.push(
            L.polygon(latlngs, {
              ...style,
              interactive: false,
              lineJoin: "round",
            })
          );
        }
      }
      return polygons.length > 0 ? L.layerGroup(polygons) : null;
    })();

    shakemapLayer?.addTo(map);
    realLayer.addTo(map);
    synthLayer.addTo(map);
    nodesLayer.addTo(map);
    epicenterLayer.addTo(map);

    mapRef.current = map;
    realLayerRef.current = realLayer;
    synthLayerRef.current = synthLayer;
    nodesLayerRef.current = nodesLayer;
    epicenterLayerRef.current = epicenterLayer;
    shakemapLayerRef.current = shakemapLayer;
    const clearUserLocation = () => {
      if (userLocationLayerRef.current) {
        map.removeLayer(userLocationLayerRef.current);
        userLocationLayerRef.current = null;
      }
    };

    const showUserLocation = ({ lat, lon, accuracy }: UserLocation) => {
      clearUserLocation();
      const distKm = haversineKm(lat, lon, epiLat, epiLon);
      const accuracyCircle = L.circle([lat, lon], {
        radius: Math.max(accuracy, 30),
        color: "#2563eb",
        weight: 1,
        fillColor: "#3b82f6",
        fillOpacity: 0.14,
        interactive: false,
      });
      const marker = L.circleMarker([lat, lon], {
        radius: 7,
        color: "#ffffff",
        weight: 2.5,
        fillColor: "#2563eb",
        fillOpacity: 1,
      }).bindPopup(
        buildPopupCard({
          badges: ["Geolocalización"],
          title: "Tu ubicación actual",
          metrics: [
            { label: "Al epicentro 27F", value: `${distKm.toFixed(1)} km` },
            { label: "Precisión", value: `±${Math.round(accuracy)} m` },
          ],
          description: `Coordenadas ${lat.toFixed(4)}°, ${lon.toFixed(4)}°`,
        }),
        { maxWidth: 320 }
      );

      const group = L.layerGroup([accuracyCircle, marker]).addTo(map);
      userLocationLayerRef.current = group;
      map.flyTo([lat, lon], Math.max(map.getZoom(), 11), { duration: 0.85 });
      marker.openPopup();
    };

    onMapReady?.({
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
      resetView: () => map.setView(INITIAL_CENTER, INITIAL_ZOOM, { animate: true }),
      showUserLocation,
      clearUserLocation,
    });

    return () => {
      onMapReady?.(null);
      clearUserLocation();
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      contextLayersRef.current = {};
    };
  }, [edges, nodes, earthquake, shakemap, onMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    const spec = MAP_STYLES[mapStyle];
    tileLayerRef.current = L.tileLayer(spec.url, {
      attribution: spec.attribution,
      maxZoom: spec.maxZoom,
    }).addTo(map);
    tileLayerRef.current.bringToBack();
  }, [mapStyle]);

  useEffect(() => {
    const isBaseline = mode === "baseline";
    const cutoff = threshold / 100;

    realLayerRef.current?.setStyle((feature) => {
      const p = (feature?.properties as EdgeProperties | undefined)?.p_failure ?? 0;
      const highlighted = isBaseline || p >= cutoff;
      return {
        color: isBaseline ? "#16a34a" : failureColor(p),
        weight: highlighted ? 2.5 : 1,
        opacity: highlighted ? 0.88 : 0.14,
      };
    });

    synthLayerRef.current?.setStyle((feature) => {
      const p = (feature?.properties as EdgeProperties | undefined)?.p_failure ?? 0;
      const highlighted = isBaseline || p >= cutoff;
      return {
        color: isBaseline ? "#4f46e5" : failureColor(p),
        weight: highlighted ? 2.8 : 1.2,
        opacity: highlighted ? 0.92 : 0.18,
        dashArray: "7 5",
      };
    });
  }, [mode, threshold]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sync = (layer: L.Layer | null, visible: boolean) => {
      if (!layer) return;
      if (visible && !map.hasLayer(layer)) layer.addTo(map);
      if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
    };

    sync(realLayerRef.current, layers.realFiber);
    sync(synthLayerRef.current, layers.syntheticLinks);
    sync(nodesLayerRef.current, layers.keyNodes);
    sync(epicenterLayerRef.current, layers.epicenter);
    sync(shakemapLayerRef.current, layers.shakemap);

    for (const ctx of CONTEXT_LAYERS) {
      const want = layers[ctx.key];
      const existing = contextLayersRef.current[ctx.key];
      if (existing) {
        sync(existing, want);
      } else if (want) {
        fetch(`/api/output/layers/${ctx.file}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((doc: FeatureCollection | null) => {
            if (!doc || !mapRef.current) return;
            const geoLayer = L.geoJSON(doc, {
              style: {
                color: ctx.color,
                weight: 1.2,
                opacity: 0.6,
                dashArray: "3 4",
              },
            });
            contextLayersRef.current[ctx.key] = geoLayer;
            geoLayer.addTo(mapRef.current);
          })
          .catch(() => undefined);
      }
    }
  }, [layers]);

  return (
    <div
      ref={containerRef}
      data-layout="map-canvas"
      data-map-style={mapStyle}
      aria-label="Mapa Leaflet de infraestructura y epicentro"
    />
  );
}
