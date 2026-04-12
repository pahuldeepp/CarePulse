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
