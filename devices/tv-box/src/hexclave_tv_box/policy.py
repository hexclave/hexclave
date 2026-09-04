"""Central pilot policy values and the deterministic Wi-Fi recovery state machine."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

INITIAL_NETWORK_RETRY_SECONDS = 300
SETUP_AP_WINDOW_SECONDS = 900
NETWORK_RETRY_WINDOW_SECONDS = 120
NETWORK_POLL_SECONDS = 5
FRONTEND_RECOVERY_PROBE_SECONDS = 60
SETUP_PORTAL_READY_TIMEOUT_SECONDS = 10
MAX_PORTAL_REQUEST_BYTES = 4096
MAX_PORTAL_SUBMISSIONS_PER_MINUTE = 5


class NetworkMode(StrEnum):
    CONNECTED = "connected"
    STATION_INITIAL = "station-initial"
    SETUP = "setup"
    STATION_RETRY = "station-retry"


@dataclass(frozen=True)
class NetworkPolicy:
    initial_retry_seconds: int = INITIAL_NETWORK_RETRY_SECONDS
    setup_window_seconds: int = SETUP_AP_WINDOW_SECONDS
    retry_window_seconds: int = NETWORK_RETRY_WINDOW_SECONDS

    def __post_init__(self) -> None:
        if min(self.initial_retry_seconds, self.setup_window_seconds, self.retry_window_seconds) <= 0:
            raise ValueError("TV Box network policy durations must be positive.")


@dataclass(frozen=True)
class NetworkState:
    mode: NetworkMode
    entered_at: float


def initial_network_state(*, has_saved_network: bool, connected: bool, now: float) -> NetworkState:
    if connected:
        return NetworkState(NetworkMode.CONNECTED, now)
    if has_saved_network:
        return NetworkState(NetworkMode.STATION_INITIAL, now)
    return NetworkState(NetworkMode.SETUP, now)


def advance_network_state(
    state: NetworkState,
    *,
    has_saved_network: bool,
    connected: bool,
    portal_submission_active: bool,
    now: float,
    policy: NetworkPolicy = NetworkPolicy(),
) -> NetworkState:
    """Return the next state without performing any network or service side effects."""
    if now < state.entered_at:
        raise ValueError("TV Box network policy received a non-monotonic timestamp.")
    if connected:
        return state if state.mode is NetworkMode.CONNECTED else NetworkState(NetworkMode.CONNECTED, now)
    if not has_saved_network:
        return state if state.mode is NetworkMode.SETUP else NetworkState(NetworkMode.SETUP, now)
    if state.mode is NetworkMode.CONNECTED:
        return NetworkState(NetworkMode.STATION_INITIAL, now)

    elapsed = now - state.entered_at
    if state.mode is NetworkMode.STATION_INITIAL and elapsed >= policy.initial_retry_seconds:
        return NetworkState(NetworkMode.SETUP, now)
    if state.mode is NetworkMode.SETUP:
        if portal_submission_active:
            return state
        if elapsed >= policy.setup_window_seconds:
            return NetworkState(NetworkMode.STATION_RETRY, now)
    if state.mode is NetworkMode.STATION_RETRY and elapsed >= policy.retry_window_seconds:
        return NetworkState(NetworkMode.SETUP, now)
    return state
