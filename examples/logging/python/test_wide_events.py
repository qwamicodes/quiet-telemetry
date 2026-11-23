import asyncio
import json
import unittest

from wide_events import LoggingConfig, REDACTED, should_sample, wide_event_middleware, wide_event_worker


def scope(**changes):
    return {"type": "http", "method": "POST", "path": "/orders",
            "headers": [(b"content-type", b"application/json")],
            "query_string": b"", **changes}


async def response(send, status=200, *, headers=None):
    await send({"type": "http.response.start", "status": status,
                "headers": headers or [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": b'{}'})


async def invoke(app, request=None, incoming=None, sender=None):
    sent = []
    messages = iter(incoming or [{"type": "http.request", "body": b'{}'}])

    async def receive():
        return next(messages, {"type": "http.disconnect"})

    async def send(message):
        if sender:
            await sender(message)
        sent.append(message)

    await app(request if request is not None else scope(), receive, send)
    return sent


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.lines = []
        self.metrics = []
        self.health = []
        self.config = LoggingConfig("test-service", "test", self.lines.append,
                                    measure=self.metrics.append, logging_failure=self.health.append)

    def event(self):
        self.assertEqual(len(self.lines), 1)
        return json.loads(self.lines[0])

    async def test_direct_enrichment_core_protected_and_stable_snapshot(self):
        request = scope(path="/orders?secret=hidden#fragment")

        async def app(s, receive, send):
            self.assertTrue(s["wide_event"]["request_id"])
            self.assertEqual(s["wide_event"]["service"], "test-service")
            s["wide_event"].update(flow="create_order", user={"email": "a@example.test"},
                                   service="forged", status_code=999, request_id="forged")
            await response(send, 201)

        sent = await invoke(wide_event_middleware(app, self.config), request)
        event = self.event()
        self.assertEqual((event["service"], event["status_code"], event["level"]),
                         ("test-service", 201, "info"))
        self.assertEqual(event["path"], "/orders")
        self.assertTrue(event["timestamp"].endswith("Z"))
        self.assertGreaterEqual(event["duration_ms"], 0)
        self.assertEqual(sent[0]["headers"][-1][1].decode(), event["request_id"])
        self.assertEqual(event["request"]["body_capture"], "disabled")
        request["wide_event"]["user"]["email"] = "late mutation"
        self.assertEqual(json.loads(self.lines[0])["user"]["email"], "a@example.test")

    async def test_trust_validation_duplicate_ids_and_isolation(self):
        async def app(s, receive, send):
            s["wide_event"]["order"] = {"id": s["path"]}
            await asyncio.sleep(0)
            await response(send)

        wrapped = wide_event_middleware(app, self.config)
        headers = [(b"X-Request-ID", b"req_trusted")]
        await invoke(wrapped, scope(headers=headers))
        self.assertNotEqual(self.event()["request_id"], "req_trusted")
        self.config.trust_request_id = True
        for value in (b"req_trusted", b"bad\r\nheader", b"x" * 129):
            self.lines.clear()
            await invoke(wrapped, scope(headers=[(b"x-request-id", value)]))
            self.assertEqual(self.event()["request_id"] == value.decode(), value == b"req_trusted")
        self.lines.clear()
        await invoke(wrapped, scope(headers=headers * 2))
        self.assertNotEqual(self.event()["request_id"], "req_trusted")
        self.lines.clear()
        self.config.trust_request_id = False
        await asyncio.gather(*(invoke(wrapped, scope(path=f"/orders/{i}")) for i in range(20)))
        events = [json.loads(line) for line in self.lines]
        self.assertEqual(len({event["request_id"] for event in events}), 20)
        self.assertTrue(all(event["path"] == event["order"]["id"] for event in events))

    async def test_nested_deployment_is_isolated_and_oversized_text_is_omitted(self):
        self.config.deployment = {"build": {"labels": []}}
        secret = "secret-" + "x" * 5000
        self.config.text_scrubber = lambda value: value.replace(secret, REDACTED)

        async def app(s, receive, send):
            s["wide_event"]["build"]["labels"].append(s["path"])
            s["wide_event"]["note"] = secret
            await asyncio.sleep(0)
            await response(send)

        wrapped = wide_event_middleware(app, self.config)
        await asyncio.gather(*(invoke(wrapped, scope(path=f"/{i}")) for i in range(2)))
        events = [json.loads(line) for line in self.lines]
        self.assertTrue(all(e["build"]["labels"] == [e["path"]] for e in events))
        self.assertEqual(self.config.deployment["build"]["labels"], [])
        self.assertTrue(all(e["note"] == "[OMITTED]" for e in events))
        self.assertNotIn("secret-", "".join(self.lines))

    async def test_actual_error_response_and_rethrow(self):
        class PaymentError(Exception):
            pass

        async def failing(s, receive, send):
            error = PaymentError("provider failed")
            error.code = "DECLINED"
            error.details = {"refresh-token": "hidden", "retryable": False}
            raise error

        # Minimal framework-style error-to-response layer, deliberately INSIDE logging.
        async def error_response(s, receive, send):
            try:
                await failing(s, receive, send)
            except Exception:
                await response(send, 503)
                raise

        sent = []

        async def sender(message):
            sent.append(message)

        with self.assertRaises(PaymentError):
            await invoke(wide_event_middleware(error_response, self.config), sender=sender)
        event = self.event()
        self.assertEqual(sent[0]["status"], 503)
        self.assertEqual(event["status_code"], 503)
        self.assertEqual(event["error"]["code"], "DECLINED")
        self.assertEqual(event["error"]["details"], {"refresh-token": REDACTED, "retryable": False})

    async def test_no_invented_status_before_response_and_handled_redirect(self):
        async def failing(s, receive, send):
            raise ValueError("no response")

        with self.assertRaises(ValueError):
            await invoke(wide_event_middleware(failing, self.config))
        self.assertNotIn("status_code", self.event())
        self.lines.clear()
        self.config.sample_rate = 0

        async def redirect(s, receive, send):
            s["wide_event"]["error"] = "OAuth exchange failed"
            await response(send, 302)

        await invoke(wide_event_middleware(redirect, self.config))
        self.assertEqual(self.event()["status_code"], 302)
        self.assertEqual(self.event()["level"], "error")
        self.assertEqual(self.event()["error"], {"message": "OAuth exchange failed"})

    async def test_tail_sampling_metrics_and_exact_slow_boundary(self):
        self.config.sample_rate = 0
        self.config.slow_ms = 1000
        now = [0.0]
        self.config.clock = lambda: now[0]

        async def app(s, receive, send):
            now[0] = 1.0
            await response(send)
            now[0] = 999.0  # Background cleanup does not inflate response latency.

        await invoke(wide_event_middleware(app, self.config))
        self.assertEqual(self.event()["duration_ms"], 1000)
        self.assertEqual(self.event()["level"], "warn")
        self.lines.clear()
        self.config.slow_ms = 1000.001
        now[0] = 0
        await invoke(wide_event_middleware(app, self.config))
        self.assertEqual(self.lines, [])
        self.assertEqual(len(self.metrics), 2)
        self.config.slo_failure = lambda event: event.get("flow") == "missed_slo"

        async def slo(s, receive, send):
            s["wide_event"]["flow"] = "missed_slo"
            await response(send)

        await invoke(wide_event_middleware(slo, self.config))
        self.assertEqual(self.event()["flow"], "missed_slo")
        self.assertEqual(len(self.metrics), 3)

    async def test_stream_trailers_and_finish_guard(self):
        now = [0.0]
        self.config.clock = lambda: now[0]
        self.config.body_fields = {"/orders": {"response": ("value",)}}

        async def app(s, receive, send):
            s["wide_event_bodies"]["response"] = {"value": "do not capture a stream"}
            await send({"type": "http.response.start", "status": 200, "trailers": True,
                        "headers": [(b"content-type", b"application/json")]})
            now[0] = 1
            await send({"type": "http.response.body", "body": b"first", "more_body": True})
            now[0] = 2
            await send({"type": "http.response.body", "body": b"last"})
            now[0] = 3
            await send({"type": "http.response.trailers", "headers": []})
            now[0] = 5
            await receive()  # After completion, disconnect is not an aborted response.

        await invoke(wide_event_middleware(app, self.config), incoming=[{"type": "http.disconnect"}])
        event = self.event()
        self.assertEqual(event["duration_ms"], 3000)
        self.assertNotIn("error", event)
        self.assertNotIn("body", event["response"])
        self.assertNotIn("body_capture", event["response"])

    async def test_disconnect_send_failure_swallowed_and_cancellation(self):
        async def disconnect(s, receive, send):
            await send({"type": "http.response.start", "status": 200})
            await receive()

        await invoke(wide_event_middleware(disconnect, self.config),
                     incoming=[{"type": "http.disconnect"}])
        self.assertEqual(self.event()["level"], "error")
        self.assertEqual(self.event()["status_code"], 200)
        self.lines.clear()

        async def broken_send(message):
            if message["type"] == "http.response.body":
                raise OSError("client closed")

        async def swallowed(s, receive, send):
            try:
                await response(send)
            except OSError:
                pass

        await invoke(wide_event_middleware(swallowed, self.config), sender=broken_send)
        self.assertEqual(self.event()["error"]["name"], "OSError")
        self.lines.clear()

        async def cancelled(s, receive, send):
            await send({"type": "http.response.start", "status": 202})
            raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await invoke(wide_event_middleware(cancelled, self.config))
        self.assertEqual(self.event()["error"]["name"], "CancelledError")

    async def test_redaction_projection_allowlists_and_no_wire_mutation(self):
        self.config.sensitive_names = ("national_id",)
        self.config.request_headers = ("authorization", "cookie", "x-tag", "content-type")
        self.config.response_headers = ("set-cookie",)
        self.config.query_fields = ("tag", "access_token")
        self.config.param_fields = ("order_id",)
        self.config.path_projector = lambda path: "/orders/:id"
        self.config.body_fields = {"/orders": {"request": ("customer",), "response": ("ok",)}}
        data = {"customer": {"email": "a@example.test", "msisdn": "2335550100",
                             "Password": "secret", "national-id": "hidden",
                             "list": [{"API_Key": "hidden"}]}, "unapproved": "excluded"}
        original_response = {"type": "http.response.start", "status": 200,
                             "headers": [(b"set-cookie", b"real-cookie"),
                                         (b"content-type", b"application/json")]}

        async def app(s, receive, send):
            s["path_params"] = {"order_id": "ord_1", "secret": "hidden"}
            s["wide_event"]["business"] = {"RefreshToken": "hidden"}
            s["wide_event_bodies"].update(request=data, response={"ok": True, "private": "hidden"})
            await send(original_response)
            await send({"type": "http.response.body", "body": b'{"ok":true}'})

        sent = await invoke(wide_event_middleware(app, self.config), scope(
            headers=[(b"Authorization", b"real-auth"), (b"Cookie", b"real-cookie"),
                     (b"X-Tag", b"a"), (b"x-tag", b"b"),
                     (b"content-type", b"application/json")],
            query_string=b"tag=a&tag=b&access_token=hidden&unapproved=hidden"))
        event = self.event()
        self.assertEqual(event["request"]["headers"]["authorization"], REDACTED)
        self.assertEqual(event["request"]["headers"]["x-tag"], ["a", "b"])
        self.assertEqual(event["request"]["query"], {"tag": ["a", "b"], "access_token": REDACTED})
        self.assertEqual(event["request"]["params"], {"order_id": "ord_1"})
        customer = event["request"]["body"]["customer"]
        self.assertEqual(customer["Password"], REDACTED)
        self.assertEqual(customer["national-id"], REDACTED)
        self.assertEqual(customer["list"][0]["API_Key"], REDACTED)
        self.assertEqual(customer["email"], "a@example.test")
        self.assertEqual(customer["msisdn"], "2335550100")
        self.assertEqual(data["customer"]["Password"], "secret")
        self.assertEqual(original_response["headers"][0][1], b"real-cookie")
        self.assertEqual(sent[0]["headers"][0][1], b"real-cookie")
        self.assertEqual(sent[1]["body"], b'{"ok":true}')
        self.assertNotIn("excluded", self.lines[0])

    async def test_body_event_bounds_cycles_depth_and_utf8(self):
        self.config.body_bytes = 128
        self.config.event_bytes = 1024
        self.config.body_fields = {"/orders": {"response": ("huge", "password")}}
        cycle = {}
        cycle["self"] = cycle

        async def app(s, receive, send):
            s["wide_event"].update(flow="checkout", business={str(i): "x" * 2000 for i in range(90)},
                                   cycle=cycle, error={"code": "FAIL", "message": "declined"})
            s["wide_event_bodies"]["response"] = {"huge": "界" * 10000, "password": "secret"}
            await response(send)

        await invoke(wide_event_middleware(app, self.config))
        event = self.event()
        self.assertLessEqual(len(self.lines[0].encode("utf-8")), 1024)
        self.assertEqual(event["flow"], "checkout")
        self.assertEqual(event["error"]["code"], "FAIL")
        self.assertEqual(event["response"]["body_capture"], "truncated")
        self.assertNotIn("secret", self.lines[0])

    async def test_sink_and_callbacks_cannot_break_response(self):
        def fail(*args):
            raise RuntimeError("not safe to log these details")

        self.config.sink = self.config.measure = fail
        self.config.logging_failure = fail

        async def app(s, receive, send):
            await response(send, 201)

        sent = await invoke(wide_event_middleware(app, self.config))
        self.assertEqual(sent[0]["status"], 201)
        self.config.sink = self.lines.append
        self.config.measure = None
        self.config.error_serializer = fail

        async def error_app(s, receive, send):
            s["wide_event"]["error"] = ValueError("secret error repr")
            await response(send)

        await invoke(wide_event_middleware(error_app, self.config))
        self.assertEqual(self.event()["error"]["message"], "Error details unavailable")
        self.assertNotIn("secret", self.lines[0])

    async def test_projected_body_limit_retains_redaction_and_scrubs_free_text(self):
        self.config.body_bytes = 128
        self.config.body_fields = {"/orders": {"response": ("huge", "password")}}
        self.config.text_scrubber = lambda value: value.replace("unsafe-token", REDACTED)

        async def app(s, receive, send):
            s["wide_event"]["error"] = "Failed with unsafe-token"
            s["wide_event_bodies"]["response"] = {"huge": "界" * 10000, "password": "unsafe-token"}
            await response(send)

        await invoke(wide_event_middleware(app, self.config))
        event = self.event()
        body = event["response"]["body"]
        serialized = json.dumps(body, ensure_ascii=True, separators=(",", ":"))
        self.assertLessEqual(len(serialized.encode("utf-8")), 128)
        self.assertEqual(body["password"], REDACTED)
        self.assertEqual(event["response"]["body_capture"], "truncated")
        self.assertNotIn("unsafe-token", self.lines[0])

    async def test_skipped_captures_route_and_large_query_do_not_drop_event(self):
        self.config.query_fields = ("tag", "code", "state")
        self.config.body_fields = {"/orders": {"request": ("value",), "response": ("value",)}}

        async def app(s, receive, send):
            class Route:
                path = "/orders/{id}"

            s["route"] = Route()
            await receive()
            s["wide_event_bodies"]["request"] = {"value": "skip streaming input"}
            await response(send, headers=[(b"content-type", b"multipart/form-data")])

        await invoke(wide_event_middleware(app, self.config),
                     scope(query_string=b"tag=x&" * 200),
                     incoming=[{"type": "http.request", "body": b"chunk", "more_body": True}])
        event = self.event()
        self.assertEqual(event["request"]["route"], "/orders/{id}")
        self.assertNotIn("query", event["request"])
        self.assertNotIn("body", event["request"])
        self.assertNotIn("body_capture", event["request"])
        self.assertNotIn("body_capture", event["response"])
        self.lines.clear()
        await invoke(wide_event_middleware(app, self.config),
                     scope(query_string=b"code=secret&state=secret&state=secret"))
        self.assertEqual(self.event()["request"]["query"],
                         {"code": REDACTED, "state": [REDACTED, REDACTED]})

    async def test_impossible_event_budget_reports_health_and_keeps_response(self):
        self.config.event_bytes = 256
        self.config.service = "s" * 4000

        async def app(s, receive, send):
            await response(send)

        sent = await invoke(wide_event_middleware(app, self.config))
        self.assertEqual(sent[0]["status"], 200)
        self.assertEqual(self.lines, [])
        self.assertEqual(len(self.metrics), 1)
        self.assertIn("emission_failed", self.health)

    async def test_late_terminal_signals_cannot_replace_status_or_time(self):
        async def app(s, receive, send):
            await response(send, 201)
            # A broken application sends more; ASGI ignores them after completion.
            await response(send, 599)
            await receive()

        await invoke(wide_event_middleware(app, self.config), incoming=[{"type": "http.disconnect"}])
        self.assertEqual(self.event()["status_code"], 201)
        self.assertNotIn("error", self.event())

    async def test_non_http_passes_through(self):
        async def app(s, receive, send):
            self.assertNotIn("wide_event", s)

        await invoke(wide_event_middleware(app, self.config), {"type": "lifespan"})
        self.assertEqual(self.lines, [])

    async def test_unsupported_values_never_use_repr_or_break_core_metadata(self):
        class Opaque:
            def __repr__(self):
                raise AssertionError("must not stringify arbitrary objects")

        cycle = {}
        cycle["self"] = cycle
        deep = {"child": "end"}
        for _ in range(15):
            deep = {"child": deep}

        async def app(s, receive, send):
            s["wide_event"].update(cycle=cycle, deep=deep, opaque=Opaque(),
                                   not_finite=float("nan"), huge_integer=1 << 1000,
                                   surrogate="\ud800", dense=[[i for i in range(64)] for _ in range(64)])
            await response(send)

        await invoke(wide_event_middleware(app, self.config))
        event = self.event()
        self.assertEqual(event["status_code"], 200)
        self.assertEqual(event["request"]["headers"]["content-type"], "application/json")
        self.assertEqual(event["cycle"]["self"], "[OMITTED]")
        self.assertEqual(event["opaque"], "[OMITTED]")
        self.assertEqual(event["not_finite"], "[OMITTED]")
        self.assertEqual(event["huge_integer"], "[OMITTED]")
        self.assertEqual(event["surrogate"], "\ud800")
        self.assertIn("[OMITTED]", json.dumps(event["deep"]))
        self.lines[0].encode("utf-8", "strict")


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.lines = []
        self.metrics = []
        self.config = LoggingConfig("worker", "test", self.lines.append, sample_rate=0,
                                    measure=self.metrics.append)

    async def test_first_success_retry_unconfirmed_and_confirmed_recovery(self):
        async def handler(event):
            event["flow"] = "fulfill_order"
            return 42

        self.assertEqual(await wide_event_worker(handler, {}, self.config,
                                                job_metadata={"job_id": "j1", "attempt": 0}), 42)
        await wide_event_worker(handler, {}, self.config, job_metadata={"job_id": "j1", "attempt": 7})
        self.assertEqual(self.lines, [])  # Retry number is not a success confirmation.
        await wide_event_worker(handler, {}, self.config,
                                job_metadata={"job_id": "j1", "attempt": 7},
                                confirmed_recovery=lambda: True)
        self.assertEqual(len(self.lines), 1)
        event = json.loads(self.lines[0])
        self.assertEqual(event["level"], "info")
        self.assertEqual(event["attempt"], 7)
        self.assertNotIn("request_id", event)
        self.assertNotIn("status_code", event)
        self.assertEqual(len(self.metrics), 3)

    async def test_worker_omits_http_fields_and_copies_native_metadata(self):
        self.config.sample_rate = 1
        metadata = {"job_id": "j", "native": {"attempts": []}, "status_code": 200}

        async def handler(event):
            self.assertNotIn("method", event)
            event["native"]["attempts"].append(1)
            event["request"] = {"body": "unrelated HTTP data"}

        await wide_event_worker(handler, {"method": "POST"}, self.config, job_metadata=metadata)
        event = json.loads(self.lines[0])
        self.assertNotIn("status_code", event)
        self.assertNotIn("request", event)
        self.assertEqual(metadata["native"]["attempts"], [])

    async def test_failure_cancel_ack_failure_and_request_continuity(self):
        for exception in (RuntimeError("attempt failed"), asyncio.CancelledError(),
                          OSError("broker ack failed")):
            async def handler(event):
                raise exception

            with self.assertRaises(type(exception)):
                await wide_event_worker(handler, {}, self.config,
                                        job_metadata={"job_id": "j", "request_id": "req_parent"},
                                        confirmed_recovery=True)
        events = [json.loads(line) for line in self.lines]
        self.assertEqual(len(events), 3)
        self.assertTrue(all(event["level"] == "error" for event in events))
        self.assertTrue(all(event["request_id"] == "req_parent" for event in events))

    async def test_native_queue_identity_survives_budget_and_native_error_slots(self):
        self.config.event_bytes = 512
        self.config.deployment = {"region": "test-region"}

        async def handler(event):
            self.assertEqual(event["native_task_key"], "job-actual")
            event["flow"] = "fulfill_order"
            event["large_business"] = {str(i): "x" * 3000 for i in range(64)}
            raise OSError(5, "I/O failed")

        with self.assertRaises(OSError):
            await wide_event_worker(handler, {}, self.config,
                                    job_metadata={"native_task_key": "job-actual", "try_index": 0})
        event = json.loads(self.lines[0])
        self.assertLessEqual(len(self.lines[0].encode()), 512)
        self.assertEqual(event["native_task_key"], "job-actual")
        self.assertEqual(event["try_index"], 0)
        self.assertEqual(event["error"]["errno"], 5)
        self.assertEqual(event["flow"], "fulfill_order")

    async def test_default_rate_success_and_handled_failure(self):
        self.config.sample_rate = 1

        async def handler(event):
            event["user"] = {"email": "visible@example.test", "access_token": "hidden"}

        await wide_event_worker(handler, {}, self.config, job_metadata={"job_id": "j"})
        self.assertEqual(json.loads(self.lines[0])["level"], "info")
        self.assertEqual(json.loads(self.lines[0])["user"]["access_token"], REDACTED)
        self.config.sample_rate = 0

        async def handled(event):
            event["error"] = "known failure"

        await wide_event_worker(handled, {}, self.config, job_metadata={"job_id": "j"})
        self.assertEqual(json.loads(self.lines[-1])["level"], "error")


class PolicyTests(unittest.TestCase):
    def test_sampling_retention_predicates_and_config_validation(self):
        config = LoggingConfig("s", "e", lambda line: None, sample_rate=0)
        self.assertFalse(should_sample({"level": "info"}, config))
        for event in ({"status_code": 400}, {"error": {}}, {"level": "warn"}):
            self.assertTrue(should_sample(event, config))
        config.retain = lambda event: event.get("vip", False)
        self.assertTrue(should_sample({"vip": True}, config))
        config.sample_rate = .5
        config.random_value = lambda: .499
        self.assertTrue(should_sample({}, config))
        config.random_value = lambda: .5
        self.assertFalse(should_sample({}, config))
        health = []
        config.logging_failure = health.append

        def broken_slo(event):
            raise RuntimeError("predicate failed")

        config.slo_failure = broken_slo
        self.assertTrue(should_sample({}, config))
        self.assertEqual(health, ["predicate_failed"])
        for kwargs in ({"sample_rate": -1}, {"sample_rate": float("nan")}, {"slow_ms": -1},
                       {"body_bytes": 10}, {"event_bytes": 100}):
            with self.assertRaises(ValueError):
                LoggingConfig("s", "e", lambda line: None, **kwargs)


if __name__ == "__main__":
    unittest.main()
