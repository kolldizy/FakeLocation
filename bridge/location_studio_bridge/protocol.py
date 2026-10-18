"""Typed error model and JSON envelopes for the Location Studio bridge protocol.

The bridge speaks newline-delimited JSON over stdin/stdout. Every error crossing
that boundary carries a stable machine-readable ``code`` so the UI can branch on
it instead of matching message text.
"""

from __future__ import annotations

from typing import Any, Optional


class ErrorCode:
    """Stable error codes shared with the Electron main process and the renderer."""

    INVALID_REQUEST = "INVALID_REQUEST"
    INVALID_PARAMS = "INVALID_PARAMS"
    UNKNOWN_METHOD = "UNKNOWN_METHOD"
    DEPENDENCY_MISSING = "DEPENDENCY_MISSING"
    USBMUX_UNAVAILABLE = "USBMUX_UNAVAILABLE"
    DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND"
    DEVICE_DISCONNECTED = "DEVICE_DISCONNECTED"
    NOT_PAIRED = "NOT_PAIRED"
    PAIRING_FAILED = "PAIRING_FAILED"
    DEVELOPER_MODE_DISABLED = "DEVELOPER_MODE_DISABLED"
    TUNNEL_FAILED = "TUNNEL_FAILED"
    TUNNEL_UNAVAILABLE = "TUNNEL_UNAVAILABLE"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    SIMULATION_ACTIVE = "SIMULATION_ACTIVE"
    NO_ACTIVE_SIMULATION = "NO_ACTIVE_SIMULATION"
    SIMULATION_FAILED = "SIMULATION_FAILED"
    UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"
    TIMEOUT = "TIMEOUT"
    INTERNAL = "INTERNAL"


class BridgeError(Exception):
    """An error that is safe and useful to serialise back to the client."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Optional[str] = None,
        *,
        remedy: Optional[str] = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details
        self.remedy = remedy
        self.retryable = retryable

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            payload["details"] = self.details
        if self.remedy:
            payload["remedy"] = self.remedy
        return payload


class ValidationError(BridgeError):
    """Raised when a request payload fails validation."""

    def __init__(self, message: str, details: Optional[str] = None) -> None:
        super().__init__(ErrorCode.INVALID_PARAMS, message, details)


class UnsupportedOperation(BridgeError):
    """Raised when the connected device genuinely cannot perform an operation."""

    def __init__(self, message: str, details: Optional[str] = None) -> None:
        super().__init__(ErrorCode.UNSUPPORTED_OPERATION, message, details, retryable=False)


def success(request_id: Any, result: Any) -> dict[str, Any]:
    return {"type": "response", "id": request_id, "ok": True, "result": result}


def failure(request_id: Any, error: BridgeError) -> dict[str, Any]:
    return {"type": "response", "id": request_id, "ok": False, "error": error.to_dict()}


def event(name: str, data: Any) -> dict[str, Any]:
    return {"type": "event", "event": name, "data": data}
