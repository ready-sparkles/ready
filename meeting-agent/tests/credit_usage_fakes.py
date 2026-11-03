"""Provider-only scope for existing prompt/domain tests; lifecycle tests use the real scope."""
from typing import Any


class ProviderOnlyCreditUsage:
    async def create_response(self, client: Any, *, is_unbounded: bool = False, **request: Any) -> Any:
        return await client.responses.create(**request)
