import math
import pytest
from src.reliability import attr, failure_probability, fragility_hazus, pga_youngs1997


def test_series_path():
    result = attr([1, 2, 3], [(1, 2, 0.2), (2, 3, 0.3)], [1, 3])
    assert result['value'] == pytest.approx(0.8 * 0.7)


def test_parallel_links_not_overwritten():
    assert attr([1, 2], [(1, 2, 0.2), (1, 2, 0.3)], [1, 2])['value'] == pytest.approx(1 - 0.2 * 0.3)


def test_average_pairs_is_not_all_terminal_probability():
    # Two connected terminals and one isolated => 1 of 3 pairs, not zero.
    result = attr([1, 2, 3], [(1, 2, 0.0)], [1, 2, 3])
    assert result['value'] == pytest.approx(1 / 3)
    assert result['node_connectivity'] == [0.5, 0.5, 0.0]


def test_probability_one_removes_link():
    assert attr([1, 2], [(1, 2, 1.0)], [1, 2])['value'] == 0.0


def test_monte_carlo_matches_exact_and_reproduces():
    exact = attr([1, 2, 3], [(1, 2, 0.4), (2, 3, 0.4), (1, 3, 0.4)], [1, 2, 3])
    mc = attr([1, 2, 3], [(1, 2, 0.4), (2, 3, 0.4), (1, 3, 0.4)], [1, 2, 3], iterations=20000, exact_limit=0)
    again = attr([1, 2, 3], [(1, 2, 0.4), (2, 3, 0.4), (1, 3, 0.4)], [1, 2, 3], iterations=20000, exact_limit=0)
    assert mc == again
    assert abs(mc['value'] - exact['value']) < mc['hoeffding_half_width']


@pytest.mark.parametrize('p', [-0.1, 1.1, float('nan')])
def test_reject_invalid_probability(p):
    with pytest.raises(ValueError):
        attr([1, 2], [(1, 2, p)], [1, 2])


def test_duplicate_terminal_is_rejected():
    with pytest.raises(ValueError):
        attr([1, 2], [(1, 2, 0.0)], [1, 1])


def test_youngs1997_attenuation_and_site_amplification():
    pga_near_soil = pga_youngs1997(33.0, magnitude=8.8, depth_km=22.9, site='soil')
    pga_far_soil = pga_youngs1997(300.0, magnitude=8.8, depth_km=22.9, site='soil')
    pga_near_rock = pga_youngs1997(33.0, magnitude=8.8, depth_km=22.9, site='rock')
    pga_rrup = pga_youngs1997(31.53, magnitude=8.8, depth_km=22.9, site='soil', is_rupture_distance=True)
    assert 0.30 < pga_near_soil < 0.40
    assert 0.34 < pga_rrup < 0.40
    assert pga_rrup > pga_youngs1997(31.53, magnitude=8.8, depth_km=22.9, site='soil', is_rupture_distance=False)
    assert pga_near_soil > pga_far_soil > 0.0
    assert pga_near_soil > pga_near_rock


def test_hazus_fragility_median_is_half():
    assert fragility_hazus(0.30, median_pga=0.30, beta=0.50) == pytest.approx(0.5)
    assert fragility_hazus(0.0, median_pga=0.30, beta=0.50) == 0.0
    assert 0.0 < fragility_hazus(0.60, median_pga=0.30, beta=0.50) < 1.0


def test_failure_probability_decreases_with_distance_and_stays_in_unit_interval():
    p10 = failure_probability(10.0)
    p100 = failure_probability(100.0)
    p400 = failure_probability(400.0)
    assert 0.0 <= p400 < p100 < p10 <= 1.0
    assert p10 > 0.5
    assert p400 < 0.01
