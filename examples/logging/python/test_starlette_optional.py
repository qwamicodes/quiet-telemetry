"""Optional real-framework checks; the default unittest suite needs no packages."""

import importlib.util
import json
import unittest

from test_wide_events import invoke, scope
from wide_events import LoggingConfig, wide_event_middleware


@unittest.skipUnless(importlib.util.find_spec("starlette"), "optional Starlette check dependency")
class StarletteTests(unittest.IsolatedAsyncioTestCase):
    async def test_generated_500_and_handled_418(self):
        from starlette.applications import Starlette
        from starlette.exceptions import HTTPException
        from starlette.routing import Route

        async def fail(request):
            request.scope["wide_event"]["flow"] = "real_starlette_error"
            raise ValueError("provider failed")

        async def handled(request):
            raise HTTPException(418, "teapot")

        lines, sent = [], []
        config = LoggingConfig("test", "test", lines.append, sample_rate=0)
        app = wide_event_middleware(Starlette(routes=[Route("/fail", fail),
                                                       Route("/handled", handled)]), config)

        async def sender(message):
            sent.append(message)

        with self.assertRaises(ValueError):
            await invoke(app, scope(method="GET", path="/fail"), sender=sender)
        self.assertEqual(sent[0]["status"], 500)
        self.assertEqual(len(lines), 1)
        event = json.loads(lines[0])
        self.assertEqual(event["status_code"], 500)
        self.assertEqual(event["error"]["name"], "ValueError")
        self.assertEqual(event["flow"], "real_starlette_error")
        sent = await invoke(app, scope(method="GET", path="/handled"))
        self.assertEqual(sent[0]["status"], 418)
        self.assertEqual(json.loads(lines[-1])["status_code"], 418)
        self.assertEqual(len(lines), 2)

    async def test_real_stream_and_closed_connection(self):
        from starlette.applications import Starlette
        from starlette.requests import ClientDisconnect
        from starlette.responses import StreamingResponse
        from starlette.routing import Route

        async def endpoint(request):
            async def chunks():
                yield b"first"
                yield b"last"
            return StreamingResponse(chunks())

        lines = []
        app = wide_event_middleware(Starlette(routes=[Route("/stream", endpoint)]),
                                    LoggingConfig("test", "test", lines.append))
        request = scope(method="GET", path="/stream", asgi={"version": "3.0", "spec_version": "2.4"})
        sent = await invoke(app, request)
        self.assertEqual(b"".join(message.get("body", b"") for message in sent), b"firstlast")
        self.assertEqual(len(lines), 1)
        self.assertNotIn("error", json.loads(lines[0]))

        async def closed_connection(message):
            if message["type"] == "http.response.body":
                raise OSError("connection closed")

        with self.assertRaises(ClientDisconnect):
            await invoke(app, request, sender=closed_connection)
        self.assertEqual(len(lines), 2)
        event = json.loads(lines[-1])
        self.assertEqual(event["status_code"], 200)
        self.assertEqual(event["level"], "error")
        self.assertEqual(event["error"]["name"], "ClientDisconnect")
