"""Tests for NEWS2/qSOFA scoring and Redis dedup logic."""

from unittest.mock import AsyncMock

import pytest
from main import TelemetryReading, is_new_alert, risk_level, score_news2, score_qsofa

# ── Helpers ───────────────────────────────────────────────────────────────────


def _r(**kwargs) -> TelemetryReading:
    return TelemetryReading(device_id="d-1", tenant_id="t-1", **kwargs)


# ── NEWS2 ─────────────────────────────────────────────────────────────────────


def test_news2_normal_vitals_scores_zero():
    r = _r(respiratory_rate=16, spo2=97, heart_rate=75, systolic_bp=120, temperature=37.0, consciousness="A")
    assert score_news2(r) == 0


def test_news2_critical_low_respiratory_rate():
    assert score_news2(_r(respiratory_rate=7)) == 3


def test_news2_critical_high_respiratory_rate():
    assert score_news2(_r(respiratory_rate=25)) == 3


def test_news2_low_spo2_scores_3():
    assert score_news2(_r(spo2=90)) == 3


def test_news2_altered_consciousness_scores_3():
    assert score_news2(_r(consciousness="P")) == 3


def test_news2_high_score_combines_parameters():
    r = _r(respiratory_rate=26, spo2=90, heart_rate=135, systolic_bp=85, temperature=35.0, consciousness="V")
    assert score_news2(r) >= 7


def test_news2_ignores_missing_parameters():
    assert score_news2(_r()) == 0


def test_news2_high_systolic_bp_scores_3():
    assert score_news2(_r(systolic_bp=220)) == 3


# ── qSOFA ─────────────────────────────────────────────────────────────────────


def test_qsofa_all_three_criteria():
    assert score_qsofa(_r(respiratory_rate=23, systolic_bp=99, gcs=14)) == 3


def test_qsofa_normal_vitals_scores_zero():
    assert score_qsofa(_r(respiratory_rate=16, systolic_bp=120, gcs=15)) == 0


def test_qsofa_boundary_respiratory_rate():
    assert score_qsofa(_r(respiratory_rate=22)) == 1
    assert score_qsofa(_r(respiratory_rate=21)) == 0


# ── Risk level ────────────────────────────────────────────────────────────────


def test_risk_critical_by_news2():
    assert risk_level(news2=7, qsofa=0) == "critical"


def test_risk_critical_by_qsofa():
    assert risk_level(news2=3, qsofa=2) == "critical"


def test_risk_high():
    assert risk_level(news2=5, qsofa=1) == "high"


def test_risk_medium():
    assert risk_level(news2=2, qsofa=0) == "medium"


def test_risk_low():
    assert risk_level(news2=0, qsofa=0) == "low"


# ── Redis dedup ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dedup_first_critical_alert_returns_true():
    mock_redis = AsyncMock()
    mock_redis.set.return_value = True
    result = await is_new_alert(mock_redis, "d-1", "critical")
    assert result is True
    mock_redis.set.assert_called_once_with("risk:dedup:d-1:critical", "1", nx=True, ex=300)


@pytest.mark.asyncio
async def test_dedup_duplicate_returns_false():
    mock_redis = AsyncMock()
    mock_redis.set.return_value = None  # SET NX returns None when key exists
    assert await is_new_alert(mock_redis, "d-1", "critical") is False


@pytest.mark.asyncio
async def test_dedup_low_severity_skips_redis():
    mock_redis = AsyncMock()
    assert await is_new_alert(mock_redis, "d-1", "low") is False
    mock_redis.set.assert_not_called()


@pytest.mark.asyncio
async def test_dedup_medium_severity_skips_redis():
    mock_redis = AsyncMock()
    assert await is_new_alert(mock_redis, "d-1", "medium") is False
    mock_redis.set.assert_not_called()


@pytest.mark.asyncio
async def test_dedup_high_severity_uses_redis():
    mock_redis = AsyncMock()
    mock_redis.set.return_value = True
    assert await is_new_alert(mock_redis, "d-1", "high") is True
    mock_redis.set.assert_called_once_with("risk:dedup:d-1:high", "1", nx=True, ex=300)


# ── NEWS2 boundary conditions ─────────────────────────────────────────────────


def test_news2_respiratory_rate_boundary_8():
    """RR = 8 is ≤8 → score 3"""
    assert score_news2(_r(respiratory_rate=8)) == 3


def test_news2_respiratory_rate_boundary_9():
    """RR = 9 is 9-11 → score 1"""
    assert score_news2(_r(respiratory_rate=9)) == 1


def test_news2_respiratory_rate_boundary_12():
    """RR = 12 is 12-20 → score 0"""
    assert score_news2(_r(respiratory_rate=12)) == 0


def test_news2_respiratory_rate_boundary_21():
    """RR = 21 is 21-24 → score 2"""
    assert score_news2(_r(respiratory_rate=21)) == 2


def test_news2_spo2_boundary_91():
    """SpO2 ≤ 91 → score 3 per NHS NEWS2 Scale 1 (≤91=3, 92-93=2, 94-95=1, ≥96=0)"""
    assert score_news2(_r(spo2=91)) == 3


def test_news2_spo2_boundary_94():
    """SpO2 = 94 is 94-95 → score 1"""
    assert score_news2(_r(spo2=94)) == 1


def test_news2_spo2_boundary_96():
    """SpO2 ≥96 → score 0"""
    assert score_news2(_r(spo2=96)) == 0


def test_news2_heart_rate_boundary_40():
    """HR ≤40 → score 3"""
    assert score_news2(_r(heart_rate=40)) == 3


def test_news2_heart_rate_boundary_41():
    """HR 41-50 → score 1"""
    assert score_news2(_r(heart_rate=41)) == 1


def test_news2_heart_rate_boundary_111():
    """HR 111-130 → score 2"""
    assert score_news2(_r(heart_rate=111)) == 2


def test_news2_heart_rate_boundary_131():
    """HR ≥131 → score 3"""
    assert score_news2(_r(heart_rate=131)) == 3


def test_news2_systolic_bp_boundary_90():
    """SBP ≤90 → score 3"""
    assert score_news2(_r(systolic_bp=90)) == 3


def test_news2_systolic_bp_boundary_91():
    """SBP 91-100 → score 2"""
    assert score_news2(_r(systolic_bp=91)) == 2


def test_news2_systolic_bp_boundary_101():
    """SBP 101-110 → score 1"""
    assert score_news2(_r(systolic_bp=101)) == 1


def test_news2_systolic_bp_boundary_111():
    """SBP 111-219 → score 0"""
    assert score_news2(_r(systolic_bp=111)) == 0


def test_news2_temperature_boundary_35():
    """Temp ≤35.0 → score 3"""
    assert score_news2(_r(temperature=35.0)) == 3


def test_news2_temperature_boundary_35_1():
    """Temp 35.1-36.0 → score 1"""
    assert score_news2(_r(temperature=35.5)) == 1


def test_news2_temperature_boundary_38_1():
    """Temp 38.1-39.0 → score 1"""
    assert score_news2(_r(temperature=38.5)) == 1


def test_news2_temperature_boundary_39_1():
    """Temp >39.0 → score 2"""
    assert score_news2(_r(temperature=39.5)) == 2


def test_news2_consciousness_unresponsive():
    """AVPU = U → score 3"""
    assert score_news2(_r(consciousness="U")) == 3


def test_news2_consciousness_voice():
    """AVPU = V → score 3"""
    assert score_news2(_r(consciousness="V")) == 3


def test_news2_consciousness_alert():
    """AVPU = A → score 0"""
    assert score_news2(_r(consciousness="A")) == 0


# ── qSOFA boundary conditions ─────────────────────────────────────────────────


def test_qsofa_rr_boundary_exact_22():
    """RR exactly 22 triggers qSOFA point"""
    assert score_qsofa(_r(respiratory_rate=22)) == 1


def test_qsofa_rr_boundary_21():
    """RR 21 is below qSOFA threshold"""
    assert score_qsofa(_r(respiratory_rate=21)) == 0


def test_qsofa_sbp_boundary_100():
    """SBP exactly 100 triggers qSOFA point"""
    assert score_qsofa(_r(systolic_bp=100)) == 1


def test_qsofa_sbp_boundary_101():
    """SBP 101 is above qSOFA threshold"""
    assert score_qsofa(_r(systolic_bp=101)) == 0


def test_qsofa_gcs_boundary_14():
    """GCS exactly 14 triggers qSOFA point"""
    assert score_qsofa(_r(gcs=14)) == 1


def test_qsofa_gcs_boundary_15():
    """GCS 15 (normal) → no qSOFA point"""
    assert score_qsofa(_r(gcs=15)) == 0


def test_qsofa_missing_all_params():
    """No params → qSOFA 0"""
    assert score_qsofa(_r()) == 0


# ── Risk level edge cases ─────────────────────────────────────────────────────


def test_risk_news2_boundary_5_is_high():
    """NEWS2 = 5 → high (not medium)"""
    assert risk_level(news2=5, qsofa=0) == "high"


def test_risk_news2_boundary_4_is_medium():
    """NEWS2 = 4 → medium"""
    assert risk_level(news2=4, qsofa=0) == "medium"


def test_risk_news2_boundary_7_is_critical():
    """NEWS2 = 7 → critical"""
    assert risk_level(news2=7, qsofa=0) == "critical"


def test_risk_qsofa_2_overrides_low_news2():
    """qSOFA ≥2 → critical even with NEWS2 = 0"""
    assert risk_level(news2=0, qsofa=2) == "critical"


def test_risk_news2_1_is_low():
    """NEWS2 = 1 → low"""
    assert risk_level(news2=1, qsofa=0) == "low"
