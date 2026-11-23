"""Run directly: python3 examples/logging/python/demo.py (no server needed)."""

import asyncio
import json

from wide_events import LoggingConfig, wide_event_middleware, wide_event_worker


# One JSON sink for HTTP and worker events. Replace print with your existing logger.
config = LoggingConfig(
    service="orders", env="demo", sink=print,
    body_fields={"/orders": {"request": ("item_count", "currency"),
                              "response": ("order_id",)}},
    # Choose SLO criteria yourself; measurement runs even for sampled-out events.
    measure=lambda event: None,
)


async def orders(scope, receive, send):
    event = scope["wide_event"]
    event["flow"] = "create_order"
    event["user"] = {"id": "user_demo", "email": "customer@example.test"}
    # In a real app, use the already-parsed, size-limited JSON input here.
    data = json.loads((await receive())["body"])
    scope["wide_event_bodies"]["request"] = data
    response = {"order_id": "order_demo", "private_note": "not approved for capture"}
    scope["wide_event_bodies"]["response"] = response
    await send({"type": "http.response.start", "status": 201,
                "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": json.dumps(response).encode()})


app = wide_event_middleware(orders, config)


async def main():
    scope = {"type": "http", "method": "POST", "path": "/orders",
             "headers": [(b"content-type", b"application/json")], "query_string": b""}

    async def receive():
        return {"type": "http.request", "body": b'{"item_count":2,"currency":"GHS"}'}

    async def send(message):
        pass  # Local ASGI fixture: no network delivery is claimed.

    await app(scope, receive, send)

    async def fulfill(event):
        event["flow"] = "fulfill_order"
        event["order"] = {"id": "order_demo"}
        return "done"

    # A request-created envelope carries this ID to an owned queue explicitly.
    envelope = {"request_id": scope["wide_event"]["request_id"], "job_id": "job_demo"}
    await wide_event_worker(fulfill, {}, config, job_metadata=envelope)
    # Independent work supplies actual job identity and no request_id.
    await wide_event_worker(fulfill, {}, config, job_metadata={"job_id": "scheduled_demo"})


if __name__ == "__main__":
    asyncio.run(main())
