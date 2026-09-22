from __future__ import annotations

import unittest

from hexclave_tv_box.policy import NetworkMode, NetworkPolicy, NetworkState, advance_network_state, initial_network_state


class NetworkPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = NetworkPolicy(initial_retry_seconds=300, setup_window_seconds=900, retry_window_seconds=120)

    def test_first_boot_without_saved_network_enters_setup(self) -> None:
        self.assertEqual(
            initial_network_state(has_saved_network=False, connected=False, now=10),
            NetworkState(NetworkMode.SETUP, 10),
        )

    def test_saved_network_uses_timed_setup_cycle(self) -> None:
        state = initial_network_state(has_saved_network=True, connected=False, now=0)
        self.assertEqual(state.mode, NetworkMode.STATION_INITIAL)
        state = advance_network_state(
            state, has_saved_network=True, connected=False, portal_submission_active=False, now=299, policy=self.policy,
        )
        self.assertEqual(state.mode, NetworkMode.STATION_INITIAL)
        state = advance_network_state(
            state, has_saved_network=True, connected=False, portal_submission_active=False, now=300, policy=self.policy,
        )
        self.assertEqual(state, NetworkState(NetworkMode.SETUP, 300))
        state = advance_network_state(
            state, has_saved_network=True, connected=False, portal_submission_active=False, now=1_200, policy=self.policy,
        )
        self.assertEqual(state, NetworkState(NetworkMode.STATION_RETRY, 1_200))
        state = advance_network_state(
            state, has_saved_network=True, connected=False, portal_submission_active=False, now=1_320, policy=self.policy,
        )
        self.assertEqual(state, NetworkState(NetworkMode.SETUP, 1_320))

    def test_active_submission_holds_setup_window(self) -> None:
        state = NetworkState(NetworkMode.SETUP, 100)
        self.assertEqual(
            advance_network_state(
                state, has_saved_network=True, connected=False, portal_submission_active=True, now=2_000, policy=self.policy,
            ),
            state,
        )

    def test_backend_reachability_does_not_enter_network_policy(self) -> None:
        state = NetworkState(NetworkMode.CONNECTED, 100)
        self.assertEqual(
            advance_network_state(
                state, has_saved_network=True, connected=True, portal_submission_active=False, now=2_000, policy=self.policy,
            ),
            state,
        )

    def test_non_monotonic_time_fails_loudly(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-monotonic"):
            advance_network_state(
                NetworkState(NetworkMode.SETUP, 10),
                has_saved_network=True,
                connected=False,
                portal_submission_active=False,
                now=9,
                policy=self.policy,
            )


if __name__ == "__main__":
    unittest.main()
