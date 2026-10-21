"""Transport selection and tunnel lifecycle.

The userspace RSD tunnel owns a process-global network stack, so the interesting
behaviour is that a second device can never steal an open tunnel.
"""

from __future__ import annotations

import unittest

from location_studio_bridge.protocol import ErrorCode
from location_studio_bridge.tunnel import TunnelManager, ios_major_version, requires_tunnel


class FakeRsd:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeTunnel:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class TestVersionGating(unittest.TestCase):
    def test_ios_major_version(self) -> None:
        self.assertEqual(ios_major_version("27.0.1"), 27)
        self.assertEqual(ios_major_version("17"), 17)
        self.assertEqual(ios_major_version("16.7.2"), 16)
        self.assertEqual(ios_major_version("27.0.1 (24A446)"), 27)
        self.assertIsNone(ios_major_version(""))
        self.assertIsNone(ios_major_version(None))
        self.assertIsNone(ios_major_version("unknown"))

    def test_requires_tunnel(self) -> None:
        self.assertTrue(requires_tunnel("17.0"))
        self.assertTrue(requires_tunnel("17.4.1"))
        self.assertTrue(requires_tunnel("27.0.1"))
        self.assertFalse(requires_tunnel("16.7.11"))
        self.assertFalse(requires_tunnel("15.8"))
        # An unknown version takes the modern path, and the caller reports that
        # choice rather than assuming the device is fine.
        self.assertTrue(requires_tunnel(None))
        self.assertTrue(requires_tunnel("not-a-version"))


class TestTunnelManager(unittest.IsolatedAsyncioTestCase):
    async def test_status_of_a_closed_manager(self) -> None:
        manager = TunnelManager()
        self.assertFalse(manager.is_open)
        self.assertIsNone(manager.udid)
        self.assertFalse(manager.is_alive())
        self.assertEqual(
            manager.status(),
            {
                "open": False,
                "deviceId": None,
                "establishedCount": 0,
                "kind": "userspace",
                "transport": None,
                "wireless": False,
            },
        )

    async def test_one_tunnel_is_reused_for_the_same_device(self) -> None:
        manager = TunnelManager()
        rsd = FakeRsd()
        manager._rsd = rsd
        manager._udid = "AAAA-BBBB"
        self.assertIs(await manager.acquire("AAAA-BBBB"), rsd)
        self.assertEqual(manager.status()["establishedCount"], 0)

    async def test_a_different_device_is_refused_while_a_tunnel_is_open(self) -> None:
        manager = TunnelManager()
        manager._rsd = FakeRsd()
        manager._udid = "AAAA-BBBB"

        with self.assertRaises(Exception) as context:
            await manager.acquire("CCCC-DDDD")
        error = context.exception
        self.assertEqual(getattr(error, "code", None), ErrorCode.TUNNEL_UNAVAILABLE)
        self.assertIn("AAAA-BBBB", error.details or "")
        self.assertTrue(error.remedy)

    async def test_release_closes_both_the_rsd_and_the_tunnel(self) -> None:
        manager = TunnelManager()
        rsd = FakeRsd()
        tunnel = FakeTunnel()
        manager._rsd = rsd
        manager._tunnel = tunnel
        manager._udid = "AAAA-BBBB"

        await manager.release()

        self.assertTrue(rsd.closed)
        self.assertTrue(tunnel.closed)
        self.assertFalse(manager.is_open)
        self.assertIsNone(manager.udid)

    async def test_release_never_raises_even_if_teardown_fails(self) -> None:
        class Exploding:
            async def close(self) -> None:
                raise RuntimeError("socket already gone")

        manager = TunnelManager()
        manager._rsd = Exploding()
        manager._tunnel = Exploding()
        await manager.release()
        self.assertFalse(manager.is_open)

    async def test_release_is_safe_to_call_repeatedly(self) -> None:
        manager = TunnelManager()
        await manager.release()
        await manager.release()
        self.assertFalse(manager.is_open)


if __name__ == "__main__":
    unittest.main()
