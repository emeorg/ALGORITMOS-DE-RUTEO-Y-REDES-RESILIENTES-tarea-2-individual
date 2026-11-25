"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Layers,
  Loader2,
  LocateFixed,
  Minus,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Sun,
  X,
} from "lucide-react";

import type { MapController } from "@/components/resilience-map";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useTheme } from "@/hooks/use-theme";
import { formatKeyCombo, type ShortcutCommand } from "@/lib/shortcuts";
import type {
  EarthquakeFeature,
  LayerVisibility,
  MapStyleId,
  ResultsPayload,
  ThemeMode,
} from "@/lib/types";

const ResilienceMap = dynamic(
  () => import("@/components/resilience-map").then((m) => m.ResilienceMap),
  { ssr: false }
);

interface LoadedData {
  results: ResultsPayload;
  edges: FeatureCollection;
  nodes: FeatureCollection;
  earthquake: EarthquakeFeature;
  shakemap: FeatureCollection | null;
}

const INITIAL_LAYERS: LayerVisibility = {
  realFiber: true,
  syntheticLinks: true,
  keyNodes: true,
  epicenter: true,
  shakemap: true,
  contextPostacion: false,
  contextCaminos: false,
  contextFerry: false,
};

const NETWORK_LAYER_CONTROLS: Array<{
  key: keyof LayerVisibility;
  label: string;
}> = [
  { key: "realFiber", label: "Fibra óptica SAIP" },
  { key: "syntheticLinks", label: "Enlaces sintéticos" },
  { key: "keyNodes", label: "Nodos clave" },
  { key: "epicenter", label: "Epicentro USGS" },
  { key: "shakemap", label: "Contornos ShakeMap USGS" },
];

const CONTEXT_LAYER_CONTROLS: Array<{
  key: keyof LayerVisibility;
  label: string;
}> = [
  { key: "contextPostacion", label: "Postación eléctrica" },
  { key: "contextCaminos", label: "Caminos sin postación" },
  { key: "contextFerry", label: "Trayectos en ferry" },
];

const MAP_STYLE_OPTIONS: Array<{ value: MapStyleId; label: string }> = [
  { value: "minimal", label: "Minimalista" },
  { value: "osm", label: "OpenStreetMap" },
  { value: "topo", label: "Topográfico" },
  { value: "satellite", label: "Satelital" },
];

const MAP_STYLE_LABELS: Record<MapStyleId, string> = {
  minimal: "Minimalista",
  osm: "OpenStreetMap",
  topo: "Topográfico",
  satellite: "Satelital",
};

function percent(value: number): string {
  return `${(value * 100).toFixed(2)} %`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function Dashboard() {
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"damage" | "baseline">("damage");
  const [threshold, setThreshold] = useState<number>(0);
  const [layers, setLayers] = useState<LayerVisibility>(INITIAL_LAYERS);
  const [mapStyle, setMapStyle] = useState<MapStyleId>("minimal");
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [legendOpen, setLegendOpen] = useState<boolean>(false);
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const [geoStatus, setGeoStatus] = useState<
    "idle" | "locating" | "active" | "error"
  >("idle");
  const [geoError, setGeoError] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();
  const mapControllerRef = useRef<MapController | null>(null);

  const handleMapReady = useCallback((controller: MapController | null) => {
    mapControllerRef.current = controller;
  }, []);

  const handleLocateUser = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGeoStatus("error");
      setGeoError("Tu navegador no soporta geolocalización.");
      return;
    }

    setGeoStatus("locating");
    setGeoError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        mapControllerRef.current?.showUserLocation({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setGeoStatus("active");
      },
      (err) => {
        const message =
          err.code === err.PERMISSION_DENIED
            ? "Permiso de ubicación denegado. Habilítalo en tu navegador para ver tu posición."
            : err.code === err.POSITION_UNAVAILABLE
              ? "No fue posible determinar tu ubicación actual."
              : err.code === err.TIMEOUT
                ? "Tiempo de espera agotado al obtener tu ubicación."
                : "No se pudo acceder a tu ubicación.";
        setGeoStatus("error");
        setGeoError(message);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  }, []);

  const shortcuts = useMemo<readonly ShortcutCommand[]>(
    () => [
      {
        id: "sidebar.toggle",
        description: "Expandir o compactar el panel lateral",
        combo: { key: "ArrowLeft", ctrl: true },
        execute: () => setCollapsed((prev) => !prev),
      },
      {
        id: "legend.toggle",
        description: "Expandir o compactar panel de leyenda y capas",
        combo: { key: "ArrowDown", ctrl: true },
        execute: () => setLegendOpen((prev) => !prev),
      },
      {
        id: "map.zoomIn",
        description: "Aumentar zoom del mapa",
        combo: { key: "+", aliases: ["=", "Add"], ctrl: true, ignoreShift: true },
        execute: () => mapControllerRef.current?.zoomIn(),
      },
      {
        id: "map.zoomOut",
        description: "Alejar zoom del mapa",
        combo: {
          key: "-",
          aliases: ["_", "Subtract"],
          ctrl: true,
          ignoreShift: true,
        },
        execute: () => mapControllerRef.current?.zoomOut(),
      },
      {
        id: "shortcuts.help",
        description: "Mostrar atajos de teclado",
        combo: { key: "h", ctrl: true },
        allowInInputs: true,
        execute: () => setShortcutsOpen((prev) => !prev),
      },
    ],
    []
  );
  useShortcuts(shortcuts);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchJson<ResultsPayload>("/api/output/results.json"),
      fetchJson<FeatureCollection>("/api/output/edges.geojson"),
      fetchJson<FeatureCollection>("/api/output/nodes.geojson"),
      fetchJson<EarthquakeFeature>("/api/output/earthquake.geojson"),
      fetchJson<FeatureCollection>("/api/output/shakemap.geojson").catch(
        () => null
      ),
    ])
      .then(([results, edges, nodes, earthquake, shakemap]) => {
        if (active) setData({ results, edges, nodes, earthquake, shakemap });
      })
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "No se pudieron cargar los resultados."
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div data-layout="center-state">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Error al cargar los datos</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!data) {
    return (
      <div data-layout="center-state">
        <Card>
          <CardHeader>
            <CardTitle>Cargando escenario sísmico 27F…</CardTitle>
            <CardDescription>
              Leyendo topología SAIP, probabilidades de falla y ATTR desde PostGIS.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const { results, edges, nodes, earthquake, shakemap } = data;
  const isBaseline = mode === "baseline";
  const observedFiberKm = Math.round(
    results.layers.find((layer) => layer.used_as_network)?.length_km ?? 10313
  ).toLocaleString("es-CL");

  const toggleLayer = (key: keyof LayerVisibility, checked: boolean) => {
    setLayers((prev) => ({ ...prev, [key]: checked }));
  };

  return (
    <div data-layout="shell">
      <main data-layout="map-stage">
        <div data-layout="map-overlay">
          <Badge variant="secondary">
            27 FEB 2010 · M {results.earthquake.magnitude}
          </Badge>
        </div>
        <ResilienceMap
          edges={edges}
          nodes={nodes}
          earthquake={earthquake}
          shakemap={shakemap}
          mode={mode}
          threshold={threshold}
          layers={layers}
          mapStyle={mapStyle}
          onMapReady={handleMapReady}
        />
      </main>

      <aside data-layout="sidebar" data-collapsed={collapsed ? "true" : "false"}>
        {collapsed ? (
          <div data-layout="sidebar-compact">
            <Badge variant="secondary">
              ATTR: {percent(results.before.value)} → {percent(results.after.value)}
            </Badge>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Expandir panel"
              onClick={() => setCollapsed(false)}
            >
              <PanelLeftOpen />
            </Button>
          </div>
        ) : (
          <>
            <div data-layout="panel-header">
              <div data-layout="badges">
                <Badge variant="outline">Chile · Fibra Óptica</Badge>
                <Badge variant="secondary">SAIP 2018</Badge>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Compactar panel"
                onClick={() => setCollapsed(true)}
              >
                <PanelLeftClose />
              </Button>
            </div>
            <Separator />
            <ScrollArea>
              <div data-layout="sidebar-inner">
                <header data-layout="header">
                  <h1>Resiliencia de Internet en Chile</h1>
                  <p>
                    Evaluación probabilística de la infraestructura troncal
                    frente al terremoto del Maule.
                  </p>
                </header>

            <section data-layout="metrics" aria-label="Métricas ATTR">
              <Card size="sm">
                <CardHeader>
                  <CardDescription>ATTR antes</CardDescription>
                  <CardTitle>
                    <span data-layout="metric-value">
                      {percent(results.before.value)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p data-layout="metric-sub">Estado base operativo</p>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader>
                  <CardDescription>ATTR después</CardDescription>
                  <CardTitle>
                    <span data-layout="metric-value" data-tone="impact">
                      {percent(results.after.value)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p data-layout="metric-sub">
                    IC 95 %: {results.after.ci95.map(percent).join(" – ")}
                  </p>
                </CardContent>
              </Card>
            </section>

            <Alert>
              <AlertTitle>
                Variación: {(100 * results.difference).toFixed(2)} pts
              </AlertTitle>
              <AlertDescription>
                {results.network.real_edges.toLocaleString("es-CL")} enlaces SAIP
                · {results.network.synthetic_edges} sintéticos ·{" "}
                {results.network.vertices.toLocaleString("es-CL")} vértices ·{" "}
                {results.key_nodes.length} nodos clave
              </AlertDescription>
            </Alert>

            <Card size="sm">
              <CardHeader>
                <CardTitle>Explorar el escenario</CardTitle>
                <CardDescription>
                  Alterna el estado operativo y filtra enlaces por probabilidad.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div data-layout="stack">
                  <div data-layout="tabs-full">
                    <Tabs
                      value={mode}
                      onValueChange={(value) =>
                        setMode(value === "baseline" ? "baseline" : "damage")
                      }
                    >
                      <TabsList>
                        <TabsTrigger value="baseline">Antes del sismo</TabsTrigger>
                        <TabsTrigger value="damage">
                          Probabilidad de falla
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  <div data-layout="stack-sm">
                    <div data-layout="row-between">
                      <Label htmlFor="prob-slider">Resaltar probabilidad ≥</Label>
                      <Badge variant="secondary">{threshold} %</Badge>
                    </div>
                    <Slider
                      id="prob-slider"
                      min={0}
                      max={100}
                      value={[threshold]}
                      disabled={isBaseline}
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        setThreshold(next ?? 0);
                      }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Accordion defaultValue={["model"]}>
              <AccordionItem value="model">
                <AccordionTrigger>Modelo sísmico y supuestos</AccordionTrigger>
                <AccordionContent>
                  <div data-layout="stack-sm">
                    <p data-layout="muted-text">
                      <strong>GMPE:</strong> Youngs et al. 1997 · sitio{" "}
                      <code>{results.model.site}</code> · profundidad{" "}
                      {results.model.depth_km} km · subducción interplaca.
                    </p>
                    <p data-layout="muted-text">
                      <strong>Fragilidad:</strong> FEMA HAZUS-MH cap. 8 ·
                      circuitos de distribución · Aₘ = {results.model.median_pga_g}{" "}
                      g · β = {results.model.beta}.
                    </p>
                    <p data-layout="muted-text">
                      <strong>ATTR:</strong> {results.after.method} con{" "}
                      {results.after.realizations.toLocaleString("es-CL")}{" "}
                      realizaciones.
                    </p>
                    <ul data-layout="warnings">
                      <li>
                        La fibra SAIP de 2018 cubre {observedFiberKm} km frente a
                        ~26.534 km del Estudio SUBTEL y presenta{" "}
                        {results.network.raw_saip_components} componentes aisladas
                        por omisión de fibra soterrada urbana, como el Gran
                        Santiago.
                      </li>
                      <li>
                        Los {results.network.synthetic_edges} enlaces sintéticos
                        cubren acometidas urbanas, el anillo metropolitano,
                        continuidad troncal y el cable submarino SAm-1.
                      </li>
                      <li>
                        Se evalúa el sismo histórico de 2010 sobre infraestructura
                        levantada en 2018 usando la distancia 3D al plano de
                        ruptura oficial del USGS y condición homogénea de sitio.
                      </li>
                      <li>
                        Las fallas entre enlaces son independientes y no se
                        modelan cortes eléctricos, data centers, tsunami ni
                        tiempos de reparación.
                      </li>
                    </ul>
                    <div data-layout="links">
                      <Button
                        variant="outline"
                        size="xs"
                        nativeButton={false}
                        render={
                          <a
                            href={results.model.gmpe_url}
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        Youngs et al. 1997 <ExternalLink />
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        nativeButton={false}
                        render={
                          <a
                            href={results.model.fragility_url}
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        FEMA HAZUS-MH <ExternalLink />
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="nodes">
                <AccordionTrigger>Nodos clave y conectividad</AccordionTrigger>
                <AccordionContent>
                  <Table data-layout="nodes-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nodo</TableHead>
                        <TableHead>Antes</TableHead>
                        <TableHead>Después</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.key_nodes.map((node) => {
                        const nodeLabel = node.name.split(" — ")[0];
                        return (
                          <TableRow key={node.id}>
                            <TableCell title={nodeLabel}>{nodeLabel}</TableCell>
                            <TableCell>{percent(node.connectivity_before)}</TableCell>
                            <TableCell>{percent(node.connectivity_after)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="evidence">
                <AccordionTrigger>Datos SAIP y evidencia</AccordionTrigger>
                <AccordionContent>
                  <div data-layout="stack-sm">
                    <Table data-layout="saip-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Capa SAIP</TableHead>
                          <TableHead>km</TableHead>
                          <TableHead>Uso</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {results.layers.map((layer) => {
                          const layerLabel = layer.layer.replaceAll("_", " ");
                          return (
                            <TableRow key={layer.layer}>
                              <TableCell title={layerLabel}>{layerLabel}</TableCell>
                              <TableCell>{layer.length_km.toFixed(0)}</TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    layer.used_as_network ? "default" : "secondary"
                                  }
                                >
                                  {layer.used_as_network ? "Red" : "Contexto"}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <div data-layout="links">
                      <Button
                        variant="outline"
                        size="xs"
                        nativeButton={false}
                        render={
                          <a
                            href="/api/output/results.json"
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        results.json <ExternalLink />
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        nativeButton={false}
                        render={
                          <a
                            href="/api/output/topology.json"
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        topology.json <ExternalLink />
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
              </div>
            </ScrollArea>
          </>
        )}
      </aside>

      <section
        data-layout="legend-panel"
        data-sidebar-expanded={collapsed ? "false" : "true"}
        data-open={legendOpen ? "true" : "false"}
        aria-label="Leyenda y capas del mapa"
      >
        <div data-layout="panel-header">
          <span data-layout="legend-title">
            <Layers /> Leyenda y capas
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={legendOpen ? "Compactar leyenda" : "Expandir leyenda"}
            onClick={() => setLegendOpen((prev) => !prev)}
          >
            {legendOpen ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>

        {legendOpen && (
          <>
            <Separator />
            <ScrollArea>
              <div data-layout="legend-inner">
                <div data-layout="stack-sm">
                  <div data-layout="legend-bar" />
                  <div data-layout="legend-ticks">
                    <span>0 %</span>
                    <span>50 %</span>
                    <span>100 %</span>
                  </div>
                </div>

                <div data-layout="legend-grid">
                  <div data-layout="legend-item">
                    <i data-swatch="solid" /> Fibra SAIP
                  </div>
                  <div data-layout="legend-item">
                    <i data-swatch="dashed" /> Enlace sintético
                  </div>
                  <div data-layout="legend-item">
                    <i data-swatch="node" /> Nodo clave
                  </div>
                  <div data-layout="legend-item">
                    <i data-swatch="epicenter" /> Epicentro M 8.8
                  </div>
                </div>

                <Separator />

                <div data-layout="stack-sm">
                  {NETWORK_LAYER_CONTROLS.map(({ key, label }) => (
                    <div key={key} data-layout="row-between">
                      <Label htmlFor={`layer-${key}`}>{label}</Label>
                      <Switch
                        id={`layer-${key}`}
                        size="sm"
                        checked={layers[key]}
                        onCheckedChange={(checked) => toggleLayer(key, checked)}
                      />
                    </div>
                  ))}
                </div>

                <Separator />

                <div data-layout="stack-sm">
                  <p data-layout="muted-text">Contexto</p>
                  {CONTEXT_LAYER_CONTROLS.map(({ key, label }) => (
                    <div key={key} data-layout="row-between">
                      <Label htmlFor={`layer-${key}`}>{label}</Label>
                      <Switch
                        id={`layer-${key}`}
                        size="sm"
                        checked={layers[key]}
                        onCheckedChange={(checked) => toggleLayer(key, checked)}
                      />
                    </div>
                  ))}
                </div>

                <Separator />

                <div data-layout="stack-sm">
                  <Label>Tema</Label>
                  <div data-layout="tabs-full">
                    <Tabs
                      value={theme}
                      onValueChange={(value) => {
                        if (
                          value === "light" ||
                          value === "dark" ||
                          value === "system"
                        ) {
                          setTheme(value as ThemeMode);
                        }
                      }}
                    >
                      <TabsList>
                        <TabsTrigger value="light">
                          <Sun /> Claro
                        </TabsTrigger>
                        <TabsTrigger value="dark">
                          <Moon /> Oscuro
                        </TabsTrigger>
                        <TabsTrigger value="system">
                          <Monitor /> Sistema
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                </div>

                <div data-layout="stack-sm">
                  <Label htmlFor="map-style-select">Diseño del mapa</Label>
                  <div data-layout="select-full">
                    <Select
                      value={mapStyle}
                      onValueChange={(value) => {
                        if (
                          value === "minimal" ||
                          value === "osm" ||
                          value === "topo" ||
                          value === "satellite"
                        ) {
                          setMapStyle(value);
                        }
                      }}
                    >
                      <SelectTrigger id="map-style-select" size="sm">
                        <SelectValue>{MAP_STYLE_LABELS[mapStyle]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {MAP_STYLE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </ScrollArea>
          </>
        )}
      </section>

      {geoError && (
        <div data-layout="geo-toast" role="status" aria-live="polite">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Ubicación no disponible</AlertTitle>
            <AlertDescription>{geoError}</AlertDescription>
            <AlertAction>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Cerrar aviso de ubicación"
                onClick={() => {
                  setGeoError(null);
                  setGeoStatus("idle");
                }}
              >
                <X />
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}

      <div
        data-layout="map-controls"
        role="group"
        aria-label="Controles de zoom y ubicación del mapa"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Aumentar zoom"
          title="Aumentar zoom"
          onClick={() => mapControllerRef.current?.zoomIn()}
        >
          <Plus />
        </Button>
        <Separator />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Alejar zoom"
          title="Alejar zoom"
          onClick={() => mapControllerRef.current?.zoomOut()}
        >
          <Minus />
        </Button>
        <Separator />
        <Button
          variant={geoStatus === "active" ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label="Mostrar mi ubicación"
          aria-pressed={geoStatus === "active"}
          title="Mostrar mi ubicación"
          disabled={geoStatus === "locating"}
          onClick={handleLocateUser}
        >
          {geoStatus === "locating" ? (
            <Loader2 data-spin="true" />
          ) : (
            <LocateFixed />
          )}
        </Button>
        {geoStatus === "active" && (
          <>
            <Separator />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Volver a vista completa"
              title="Volver a vista completa"
              onClick={() => mapControllerRef.current?.resetView()}
            >
              <RotateCcw />
            </Button>
          </>
        )}
      </div>

      <div
        data-layout="shortcut-hint"
        data-sidebar-expanded={collapsed ? "false" : "true"}
        data-legend-open={legendOpen ? "true" : "false"}
      >
        <Button
          variant="ghost"
          size="xs"
          aria-label="Mostrar atajos de teclado"
          onClick={() => setShortcutsOpen(true)}
        >
          <Kbd>{formatKeyCombo({ key: "h", ctrl: true })}</Kbd>
        </Button>
      </div>

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        commands={shortcuts}
      />
    </div>
  );
}
