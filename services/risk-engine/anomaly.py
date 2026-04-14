"""
Anomaly detection for device sensor drift.
Uses IsolationForest (unsupervised) — no labelled data needed.

S4: skeleton with fit/predict interface and mock training data.
S8: replace mock data with real historical telemetry from Cassandra.
S12: wire into risk-engine Kafka consumer as a pre-score filter.
"""

import numpy as np
import structlog
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer

log = structlog.get_logger()

FEATURES = ["respiratory_rate", "spo2", "heart_rate", "systolic_bp", "temperature"]


class SensorDriftDetector:
    def __init__(self) -> None:
        self._model = IsolationForest(
            contamination=0.05,  # expect 5% outlier rate in training data
            n_estimators=100,
            random_state=42,
        )
        self._imputer = SimpleImputer(strategy="mean")
        self._fitted = False

    def fit(self, readings: list[dict]) -> None:
        """Train the detector on historical readings.

        Args:
            readings: list of telemetry dicts — same shape as TelemetryReading.
                      None values are imputed with column mean.
        """
        X = self._extract_features(readings)
        X_imputed = self._imputer.fit_transform(X)
        self._model.fit(X_imputed)
        self._fitted = True
        log.info("anomaly_detector_fitted", n_samples=len(readings))

    def predict(self, reading: dict) -> tuple[bool, float]:
        """Score a single reading for sensor drift.

        Returns:
            (is_anomaly, anomaly_score)
            score: more negative = more anomalous. Threshold ~0.0.
        """
        if not self._fitted:
            raise RuntimeError("detector not fitted — call fit() first")

        X = self._extract_features([reading])
        X_imputed = self._imputer.transform(X)
        score = float(self._model.decision_function(X_imputed)[0])
        is_anomaly = self._model.predict(X_imputed)[0] == -1
        return is_anomaly, score

    def is_fitted(self) -> bool:
        return self._fitted

    def _extract_features(self, readings: list[dict]) -> np.ndarray:
        """Extract numeric feature matrix from readings list.
        Missing values (None) become np.nan for imputation."""
        rows = []
        for r in readings:
            rows.append([r.get(f) if r.get(f) is not None else np.nan for f in FEATURES])
        return np.array(rows, dtype=float)


def train_on_mock_data() -> SensorDriftDetector:
    """Train on synthetic data for dev/test.

    500 normal readings within healthy clinical ranges +
    20 anomalous readings with extreme values.

    Replace with real Cassandra telemetry query in S8.
    """
    rng = np.random.default_rng(42)

    normal = [
        {
            "respiratory_rate": float(rng.integers(12, 20)),
            "spo2": float(rng.integers(96, 100)),
            "heart_rate": float(rng.integers(60, 90)),
            "systolic_bp": float(rng.integers(110, 140)),
            "temperature": round(float(rng.uniform(36.0, 37.5)), 1),
        }
        for _ in range(500)
    ]

    anomalous = [
        {
            "respiratory_rate": float(rng.choice([5, 6, 30, 35])),
            "spo2": float(rng.integers(80, 90)),
            "heart_rate": float(rng.choice([30, 35, 140, 150])),
            "systolic_bp": float(rng.choice([60, 70, 230, 250])),
            "temperature": round(float(rng.choice([33.0, 34.0, 40.5, 41.0])), 1),
        }
        for _ in range(20)
    ]

    detector = SensorDriftDetector()
    detector.fit(normal + anomalous)
    return detector


if __name__ == "__main__":
    detector = train_on_mock_data()

    tests = [
        ("normal", {"respiratory_rate": 16, "spo2": 98, "heart_rate": 72, "systolic_bp": 120, "temperature": 37.0}),
        (
            "borderline",
            {"respiratory_rate": 22, "spo2": 93, "heart_rate": 110, "systolic_bp": 105, "temperature": 38.2},
        ),
        ("extreme", {"respiratory_rate": 5, "spo2": 82, "heart_rate": 145, "systolic_bp": 65, "temperature": 41.0}),
    ]

    print(f"{'label':12s} | {'anomaly':7s} | {'score':>8s}")
    print("-" * 35)
    for label, reading in tests:
        is_anomaly, score = detector.predict(reading)
        print(f"{label:12s} | {str(is_anomaly):7s} | {score:8.4f}")
