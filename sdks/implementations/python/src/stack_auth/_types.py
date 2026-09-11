from __future__ import annotations

from typing import Mapping, Protocol, runtime_checkable


@runtime_checkable
class RequestLike(Protocol):
    """Protocol for objects that expose HTTP headers (e.g. Django/Flask/Starlette requests)."""

    @property
    def headers(self) -> Mapping[str, str]:
        """Return the request headers as a string mapping."""
        ...
