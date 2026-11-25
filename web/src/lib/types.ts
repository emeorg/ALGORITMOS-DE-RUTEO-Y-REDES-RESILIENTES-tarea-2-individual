export interface AttrStats {
  value: number;
  method: string;
  realizations: number;
  seed?: number;
  ci95: [number, number];
  standard_error: number;
  hoeffding_half_width: number;
  node_connectivity: number[];
}

export interface KeyNodeResult {
  id: number;
  name: string;
  role: string;
  vertex_id: number;
  snap_distance_m: number;
  reference: string;
  justification: string;
  connectivity_before: number;
  connectivity_after: number;
  connectivity_drop: number;
  unmatched: boolean;
}

export interface LayerStat {
  layer: string;
  features: number;
  length_km: number;
  used_as_network: boolean;
}

export interface EdgeProperties {
  id: number;
  name: string;
  p_failure: number;
  distance_km: number;
  pga_g: number | null;
  synthetic: boolean;
  justification: string | null;
  category: string | null;
}

export interface EarthquakeFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point";
    coordinates: [number, number, number];
  };
  properties: {
    mag: number;
    place: string;
    title: string;
    [key: string]: unknown;
  };
}

export interface ResultsPayload {
  status: string;
  demo: boolean;
  earthquake: {
    id: string;
    magnitude: number;
    depth_km: number;
    lon: number;
    lat: number;
  };
  before: AttrStats;
  after: AttrStats;
  difference: number;
  relative_change_percent: number | null;
  network: {
    edges: number;
    real_edges: number;
    synthetic_edges: number;
    vertices: number;
    components: number;
    raw_saip_components: number;
    isolated_key_nodes: number;
  };
  key_nodes: KeyNodeResult[];
  layers: LayerStat[];
  model: {
    name: string;
    gmpe_reference: string;
    gmpe_url: string;
    fragility_reference: string;
    fragility_url: string;
    function: string;
    site: string;
    magnitude: number;
    depth_km: number;
    median_pga_g: number;
    beta: number;
  };
  settings: {
    tolerance_m: number;
    snap_limit_m: number;
    srid: number;
  };
  warnings: string[];
}

export type ThemeMode = "light" | "dark" | "system";

export type MapStyleId = "minimal" | "osm" | "topo" | "satellite";

export interface LayerVisibility {
  realFiber: boolean;
  syntheticLinks: boolean;
  keyNodes: boolean;
  epicenter: boolean;
  shakemap: boolean;
  contextPostacion: boolean;
  contextCaminos: boolean;
  contextFerry: boolean;
}
