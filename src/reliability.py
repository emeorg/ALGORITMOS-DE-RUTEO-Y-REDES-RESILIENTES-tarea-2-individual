"""Average Two-Terminal Reliability (ATTR) and seismic link failure model.

Seismic model (two-stage, literature-backed):
1. Ground Motion Prediction Equation (GMPE): Youngs et al. (1997),
   "Strong Ground Motion Attenuation Relationships for Subduction Zone Earthquakes",
   Seismological Research Letters, 68(1), 58-73 (DOI: 10.1785/gssrl.68.1.58).
2. Lognormal Fragility Curve: FEMA Hazus Earthquake Model Technical Manual, Ch. 8
   (Direct Damage to Lifeline Utility Systems — Distribution Circuits, Standard
   Components, Moderate damage, Table 8-30: A_m = 0.33 g, beta = 0.20), justified because 98.3 % of Chilean SAIP
   fiber (10,164 / 10,342 km, Estudio SUBTEL 2018 Table 4.1) is aerial on poles.

ATTR definition adapted from Boettcher et al. (2018), Eqs. 8-9:
Average over distinct pairs of key terminal nodes of the probability that they
remain connected. Edges fail independently conditional on the hazard scenario.
Parallel edges are kept; isolated terminals remain in the denominator.
"""
from collections import Counter
from itertools import product
import math
import numpy as np

# Youngs et al. (1997) PGA (T = 0 s) regression coefficients for subduction zones
YOUNGS97_PARAMS = {
    'soil': dict(c1=-0.6687, c2=1.438, c3=-2.329, c4=1.097, c5=0.617, c6=0.00648, c7=0.3643),
    'rock': dict(c1=0.2418, c2=1.414, c3=-2.552, c4=1.7818, c5=0.554, c6=0.00607, c7=0.3846),
}

# FEMA Hazus-MH (Ch. 8) lognormal fragility presets for sensitivity analysis
HAZUS_PRESETS = {
    'distribution_moderate': dict(label='HAZUS 5.1, Tabla 8-30: circuitos estándar, daño moderado', median_pga=0.33, beta=0.20),
    'comm_moderate': dict(label='HAZUS 5.1, Tabla 8-38: instalaciones ancladas, daño moderado', median_pga=0.32, beta=0.60),
    'comm_extensive': dict(label='HAZUS 5.1, Tabla 8-38: instalaciones ancladas, daño extensivo', median_pga=0.60, beta=0.62),
}


def _find(parent, x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def _connected_scores_indexed(n_verts, base_parent, extra_edges, term_idx):
    parent = base_parent.copy()
    for u, v in extra_edges:
        a = _find(parent, u)
        b = _find(parent, v)
        if a != b:
            parent[b] = a
    roots = [_find(parent, t) for t in term_idx]
    groups = Counter(roots)
    k = len(term_idx)
    pairs = k * (k - 1) // 2
    score = sum(n * (n - 1) // 2 for n in groups.values()) / pairs
    node_scores = [(groups[r] - 1) / (k - 1) for r in roots]
    return score, node_scores


def attr(vertices, edges, terminals, iterations=20000, seed=27, exact_limit=16):
    """Compute ATTR over `terminals` for edges=(source, target, p_failure).

    Uses exact enumeration for <= `exact_limit` uncertain edges, otherwise Monte
    Carlo with `iterations` realizations and fixed `seed`.
    The 95 % CI uses the sample variance of per-realization ATTR across
    realizations (not assuming pair independence within a realization), plus
    an exact Hoeffding bound for variables in [0, 1].
    """
    vertices = list(dict.fromkeys(vertices))
    vertex_set = set(vertices)
    if len(terminals) < 2:
        raise ValueError('Se necesitan al menos dos nodos clave.')
    if len(set(terminals)) != len(terminals):
        raise ValueError('Dos nodos clave comparten vértice: revisar resolución topológica.')
    if not set(terminals) <= vertex_set:
        raise ValueError('Terminal sin vértice (incluya también los aislados).')
    if iterations < 2:
        raise ValueError('Monte Carlo requiere al menos dos iteraciones.')

    idx = {v: i for i, v in enumerate(vertices)}
    n_verts = len(vertices)
    term_idx = [idx[t] for t in terminals]

    indexed_edges = []
    for u, v, p in edges:
        if u not in idx or v not in idx or not math.isfinite(p) or not 0 <= p <= 1:
            raise ValueError('Enlace inválido o probabilidad fuera de [0,1].')
        indexed_edges.append((idx[u], idx[v], p))

    identity_parent = list(range(n_verts))
    possible, _ = _connected_scores_indexed(
        n_verts, identity_parent, [(u, v) for u, v, p in indexed_edges if p < 1], term_idx
    )
    if possible == 0:
        return dict(
            value=0.0,
            method='exacto: pares desconectados en todos los estados',
            realizations=1,
            ci95=[0.0, 0.0],
            standard_error=0.0,
            hoeffding_half_width=0.0,
            node_connectivity=[0.0] * len(terminals),
        )

    # Pre-contract edges with p_failure == 0 (always operational)
    base_parent = list(range(n_verts))
    for u, v, p in indexed_edges:
        if p == 0:
            a, b = _find(base_parent, u), _find(base_parent, v)
            if a != b:
                base_parent[b] = a
    for i in range(n_verts):
        base_parent[i] = _find(base_parent, i)

    uncertain = [(u, v, p) for u, v, p in indexed_edges if 0 < p < 1]
    node_sum = np.zeros(len(terminals), dtype=np.float64)

    if len(uncertain) <= exact_limit:
        mean = 0.0
        for state in product((False, True), repeat=len(uncertain)):
            weight = math.prod((1.0 - p if alive else p) for alive, (_, _, p) in zip(state, uncertain))
            live = [(u, v) for alive, (u, v, _) in zip(state, uncertain) if alive]
            score, node_scores = _connected_scores_indexed(n_verts, base_parent, live, term_idx)
            mean += weight * score
            node_sum += weight * np.array(node_scores)
        return dict(
            value=float(mean),
            method='exacto',
            realizations=2 ** len(uncertain),
            ci95=[float(mean), float(mean)],
            standard_error=0.0,
            hoeffding_half_width=0.0,
            node_connectivity=node_sum.tolist(),
        )

    # Contract graph to base components for fast Monte Carlo without altering RNG draws
    comp_map = {}
    for i in range(n_verts):
        r = base_parent[i]
        if r not in comp_map:
            comp_map[r] = len(comp_map)
    n_comp = len(comp_map)
    comp_term = [comp_map[base_parent[t]] for t in term_idx]
    comp_uncertain = [(comp_map[base_parent[u]], comp_map[base_parent[v]]) for u, v, _ in uncertain]
    probabilities = np.array([p for _, _, p in uncertain], dtype=np.float64)
    k = len(terminals)
    pairs = k * (k - 1) // 2

    rng = np.random.default_rng(seed)
    samples = np.empty(iterations, dtype=np.float64)
    comp_base = list(range(n_comp))
    for i in range(iterations):
        alive = rng.random(len(uncertain)) >= probabilities
        parent = comp_base.copy()
        for keep, (u, v) in zip(alive, comp_uncertain):
            if keep and u != v:
                a, b = _find(parent, u), _find(parent, v)
                if a != b:
                    parent[b] = a
        roots = [_find(parent, t) for t in comp_term]
        groups = Counter(roots)
        samples[i] = sum(n * (n - 1) // 2 for n in groups.values()) / pairs
        for j, r in enumerate(roots):
            node_sum[j] += (groups[r] - 1) / (k - 1)

    mean = float(samples.mean())
    se = float(samples.std(ddof=1) / math.sqrt(iterations))
    return dict(
        value=mean,
        method='Monte Carlo',
        realizations=iterations,
        seed=seed,
        ci95=[max(0.0, mean - 1.96 * se), min(1.0, mean + 1.96 * se)],
        standard_error=se,
        hoeffding_half_width=math.sqrt(math.log(40.0) / (2 * iterations)),
        node_connectivity=(node_sum / iterations).tolist(),
    )


def pga_youngs1997(distance_km, magnitude=8.8, depth_km=22.9, site='soil', z_t=0, is_rupture_distance=False):
    """Peak Ground Acceleration (in g) via Youngs et al. (1997) subduction GMPE.

    ln(PGA) = c1 + c2*M + c3*ln(R + c4*exp(c5*M)) + c6*H + c7*Z_T
    When `is_rupture_distance=True`, `distance_km` is already the 3D closest
    distance R_rup to the finite fault surface; otherwise R = sqrt(d^2 + H^2).
    Z_T = 0 (interface) or 1 (intraslab).
    """
    if site not in YOUNGS97_PARAMS:
        raise ValueError(f"Tipo de sitio inválido '{site}': usar 'soil' o 'rock'.")
    if not all(math.isfinite(x) for x in (distance_km, magnitude, depth_km)):
        raise ValueError('Parámetros sísmicos no finitos.')
    if distance_km < 0 or depth_km < 0 or magnitude <= 0 or z_t not in (0, 1):
        raise ValueError('Se requiere distance_km>=0, depth_km>=0, magnitude>0 y z_t en {0,1}.')
    c = YOUNGS97_PARAMS[site]
    r_dist = distance_km if is_rupture_distance else math.hypot(distance_km, depth_km)
    ln_pga = (
        c['c1']
        + c['c2'] * magnitude
        + c['c3'] * math.log(r_dist + c['c4'] * math.exp(c['c5'] * magnitude))
        + c['c6'] * depth_km
        + c['c7'] * z_t
    )
    return math.exp(ln_pga)


def fragility_hazus(pga_g, median_pga=0.33, beta=0.20):
    """Damage-state exceedance probability; defaults: Hazus 5.1, Table 8-30,
    standard distribution circuits, Moderate damage. Its use as link outage
    probability is a modeling assumption, not a fiber-specific calibration.
    """
    if not all(math.isfinite(x) for x in (pga_g, median_pga, beta)):
        raise ValueError('Parámetros de fragilidad no finitos.')
    if pga_g < 0 or median_pga <= 0 or beta <= 0:
        raise ValueError('Se requiere pga_g>=0, median_pga>0 y beta>0.')
    if pga_g == 0:
        return 0.0
    z = math.log(pga_g / median_pga) / beta
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def failure_probability(distance_km, magnitude=8.8, depth_km=22.9, site='soil',
                        median_pga=0.33, beta=0.20, z_t=0, is_rupture_distance=False):
    """Combined Youngs et al. (1997) PGA + FEMA HAZUS-MH fragility failure probability."""
    pga = pga_youngs1997(
        distance_km,
        magnitude=magnitude,
        depth_km=depth_km,
        site=site,
        z_t=z_t,
        is_rupture_distance=is_rupture_distance,
    )
    return fragility_hazus(pga, median_pga=median_pga, beta=beta)
