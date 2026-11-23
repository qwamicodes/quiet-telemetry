"""Dependency-free reference adaptation of Boris Tane's wide-event pattern (MIT).

https://loggingsucks.com/#implementing-wide-events
https://github.com/boristane/agent-skills/tree/main/skills/logging-best-practices
Worker lifecycle and bounded capture are quiet-specific adaptations; see README.md.
"""

from dataclasses import dataclass, field
from copy import deepcopy
from datetime import datetime, timezone
from itertools import islice
import json
import math
import random
import re
import time
from urllib.parse import parse_qsl
from uuid import uuid4


REDACTED = "[REDACTED]"
OMITTED = "[OMITTED]"
_SECRET_NAMES = {
    "authorization", "proxyauthorization", "auth", "authentication", "cookie", "cookies",
    "setcookie", "password", "passwordhash", "secretkey", "apitoken", "xauthtoken",
    "passwd", "secret", "clientsecret", "token", "accesstoken", "refreshtoken",
    "idtoken", "apikey", "xapikey", "credential", "credentials", "privatekey",
    "paymentcredentials", "cardnumber", "cvv", "cvc", "oauthcode", "oauthstate",
    "pwd", "paymenttoken", "connectionstring",
}
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_CORE = ("timestamp", "level", "service", "env", "request_id", "flow", "method",
         "path", "status_code", "duration_ms", "error")


def _name(key):
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _json(value):
    # ASCII escaping also handles lone surrogates: every emitted line is valid UTF-8.
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


@dataclass
class LoggingConfig:
    service: str
    env: str
    sink: object  # Synchronous callable accepting one JSON line, configured at startup.
    sample_rate: float = 1.0
    slow_ms: float | None = None
    slow: object = None  # Optional completed-success predicate, ORed with slow_ms.
    slo_failure: object = None  # User decides scope, eligibility and failure criteria.
    retain: object = None
    measure: object = None  # Called for EVERY unit, before diagnostic sampling.
    logging_failure: object = None  # Non-logging health counter; receives a fixed reason.
    text_scrubber: object = None  # Trusted value policy; receives every string value.
    error_serializer: object = None
    sensitive_names: tuple = ()
    deployment: dict = field(default_factory=dict)
    trust_request_id: bool = False  # Only enable behind a trusted, sanitizing ingress.
    request_headers: tuple = ("content-type",)
    response_headers: tuple = ("content-type",)
    query_fields: tuple = ()
    param_fields: tuple = ()
    path_projector: object = None  # path -> safe path or None to omit.
    # Exact ASGI path -> direction -> explicitly approved top-level JSON fields.
    body_fields: dict = field(default_factory=dict)
    body_bytes: int = 8192
    event_bytes: int = 32768
    clock: object = time.monotonic
    random_value: object = random.random

    def __post_init__(self):
        if not math.isfinite(self.sample_rate) or not 0 <= self.sample_rate <= 1:
            raise ValueError("sample_rate must be between zero and one")
        if self.slow_ms is not None and (
            not math.isfinite(self.slow_ms) or self.slow_ms < 0
        ):
            raise ValueError("slow_ms must be finite and nonnegative")
        if self.body_bytes < 32 or self.event_bytes < 256:
            raise ValueError("body_bytes >= 32 and event_bytes >= 256 are required")


def _health(config, reason):
    try:
        if config.logging_failure:
            config.logging_failure(reason)
    except Exception:
        pass


def _predicate(config, callback, event):
    try:
        return bool(callback(event)) if callback else False
    except Exception:
        _health(config, "predicate_failed")
        return True  # Keep evidence if a user retention/SLO predicate fails.


def should_sample(event, config, *, confirmed_recovery=False):
    """Tail decision; no percentage, latency or business/SLO target is hardcoded."""
    return (
        event.get("error") is not None
        or event.get("status_code", 0) >= 400
        or event.get("level") in ("warn", "error")
        or confirmed_recovery
        or _predicate(config, config.slo_failure, event)
        or _predicate(config, config.retain, event)
        or config.sample_rate == 1
        or (config.sample_rate > 0 and config.random_value() < config.sample_rate)
    )


def _error(error, config):
    if isinstance(error, str):
        return {"message": error}
    if isinstance(error, BaseException):
        try:
            if config.error_serializer:
                result = config.error_serializer(error)
                if type(result) is str:
                    return {"message": result}
                if type(result) is not dict:
                    raise ValueError("error_serializer must return a dict or string")
                return result
            result = {"name": type(error).__name__, "message": str(error)}
            result.update(islice(vars(error).items(), 62))
            for key in ("code", "reason", "details", "errno", "filename", "filename2", "strerror"):
                value = getattr(error, key, None)
                if value is not None:
                    result[key] = value
            return result
        except Exception:
            _health(config, "error_serializer_failed")
            # Never use repr(error), which can disclose the very data that failed.
            return {"message": "Error details unavailable"}
    return error


def _sanitize(value, config):
    """Copy JSON-shaped values with bounded work; no arbitrary repr/default=str."""
    secrets = _SECRET_NAMES | {_name(key) for key in config.sensitive_names}
    seen = set()
    remaining = 1024
    shortened = False

    def visit(item, depth=0):
        nonlocal remaining, shortened
        remaining -= 1
        if remaining < 0 or depth > 8:
            shortened = True
            return OMITTED
        if item is None or type(item) is bool:
            return item
        if type(item) in (int, float):
            if (type(item) is int and item.bit_length() > 256) or (
                type(item) is float and not math.isfinite(item)
            ):
                shortened = True
                return OMITTED
            return item
        if type(item) is str:
            if item in (REDACTED, OMITTED):
                return item
            if len(item) > 4096:
                shortened = True
                # Cutting before the text policy could expose part of a secret.
                return OMITTED
            if config.text_scrubber:
                item = config.text_scrubber(item)
                if type(item) is not str:
                    raise ValueError("text_scrubber must return a string")
                if len(item) > 4096:
                    shortened = True
                    item = item[:4096] + OMITTED
            return item
        if type(item) not in (dict, list, tuple) or id(item) in seen:
            shortened = True
            return OMITTED
        seen.add(id(item))
        try:
            if len(item) > 64:
                shortened = True
            if type(item) is dict:
                result = {}
                for key, child in islice(item.items(), 64):
                    if type(key) is not str or len(key) > 128:
                        shortened = True
                        continue
                    if _name(key) in secrets:
                        # Preserve repeated header/query value shape, never originals.
                        result[key] = ([REDACTED] * min(len(child), 64)
                                       if type(child) in (list, tuple) else REDACTED)
                    else:
                        result[key] = visit(child, depth + 1)
                return result
            return [visit(child, depth + 1) for child in islice(item, 64)]
        finally:
            seen.remove(id(item))

    clean = visit(value)
    return clean, shortened


def _shrink(value):
    """Shorten a JSON value, keeping redaction markers whenever a field survives."""
    if type(value) is str and value not in (REDACTED, OMITTED):
        return value[:len(value) // 2]
    if type(value) is dict and value:
        key = max(value, key=lambda key: len(_json(value[key])))
        child = _shrink(value[key])
        if child == value[key]:
            return dict(list(value.items())[:-1])
        return {**value, key: child}
    if type(value) is list and value:
        return value[:len(value) // 2]
    return value


def _fit(value, limit):
    changed = False
    while len(_json(value).encode("utf-8")) > limit:
        smaller = _shrink(value)
        if smaller == value:
            raise ValueError("minimal JSON value does not fit")
        value, changed = smaller, True
    return value, changed


def _bound_event(event, config, protected=()):
    # Bodies lose their budget before any core correlation or error fields.
    for side in ("request", "response"):
        group = event.get(side)
        if type(group) is dict and "body" in group:
            group["body"], changed = _fit(group["body"], config.body_bytes)
            if changed:
                group["body_capture"] = "truncated"
    if len(_json(event).encode("utf-8")) <= config.event_bytes:
        return _json(event)
    for side in ("request", "response"):
        group = event.get(side)
        if type(group) is dict and "body" in group:
            group.pop("body")
            group["body_capture"] = "truncated"
    # Preserve identities/timing/status/flow and useful error fields exactly.
    optional = [key for key in event if key not in (*_CORE, *protected)]
    for key in sorted(optional, key=lambda key: len(_json(event[key])), reverse=True):
        if len(_json(event).encode("utf-8")) <= config.event_bytes:
            break
        if key in ("request", "response"):
            marker = event[key].get("body_capture") if type(event[key]) is dict else None
            event[key] = {"body_capture": marker} if marker else {}
        else:
            del event[key]
    if len(_json(event).encode("utf-8")) > config.event_bytes:
        if type(event.get("error")) is dict:
            event["error"] = {key: value for key, value in event["error"].items()
                              if key in ("name", "code", "message")}
        # Core values may themselves be huge; shorten their values, never bytes.
        for key in ("path", "flow"):
            while key in event and len(_json(event).encode("utf-8")) > config.event_bytes:
                smaller = _shrink(event[key])
                if smaller == event[key]:
                    break
                event[key] = smaller
        error = event.get("error")
        if type(error) is dict and "message" in error:
            while len(_json(event).encode("utf-8")) > config.event_bytes:
                smaller = _shrink(error["message"])
                if type(smaller) is str and len(smaller) < 16:
                    smaller = OMITTED
                if smaller == error["message"]:
                    break
                error["message"] = smaller
    line = _json(event)
    if len(line.encode("utf-8")) > config.event_bytes:
        raise ValueError("minimal event does not fit")
    return line


def _complete(event, config, *, successful, confirmed_recovery=False, job_keys=()):
    try:
        if "error" in event:
            event["error"] = _error(event["error"], config)
        # Separate bounded budgets keep large business objects from starving core fields.
        core_keys = (*_CORE, *job_keys)
        core = {key: event[key] for key in core_keys if key in event and key != "level"}
        business = {key: value for key, value in islice(event.items(), 64)
                    if key not in (*core_keys, "request", "response")}
        safe, _ = _sanitize(business, config)
        safe_core, _ = _sanitize(core, config)
        safe.update(safe_core)
        for side in ("request", "response"):
            if side in event:
                group = event[side]
                safe[side], _ = _sanitize({key: value for key, value in group.items()
                                          if key != "body"}, config)
                if "body" in group:
                    body, shortened = _sanitize(group["body"], config)
                    safe[side]["body"], changed = _fit(body, config.body_bytes)
                    if shortened or changed:
                        safe[side]["body_capture"] = "truncated"
        failed = safe.get("error") is not None or safe.get("status_code", 0) >= 400
        slow = successful and not failed and (
            (config.slow_ms is not None and safe["duration_ms"] >= config.slow_ms)
            or _predicate(config, config.slow, safe)
        )
        safe["level"] = "error" if failed else "warn" if slow else "info"
        if config.measure:
            try:
                # A private copy prevents measurement mutation from changing retention.
                config.measure(json.loads(_json(safe)))
            except Exception:
                _health(config, "measurement_failed")
        if should_sample(safe, config, confirmed_recovery=confirmed_recovery and successful):
            config.sink(_bound_event(safe, config, job_keys))
    except Exception:
        _health(config, "emission_failed")


def _timing(config, start, end=None):
    elapsed = ((config.clock() if end is None else end) - start) * 1000
    return max(0.0, elapsed) if math.isfinite(elapsed) else 0.0


def _timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _pairs(pairs, allowed):
    result = {}
    for key, value in islice(pairs, 128):
        if key in allowed:
            if key in result:
                old = result[key]
                result[key] = old + [value] if isinstance(old, list) else [old, value]
            else:
                result[key] = value
    return result


def _headers(headers, allowed):
    return _pairs(((key.decode("latin-1").lower(), value.decode("latin-1"))
                   for key, value in headers), {key.lower() for key in allowed})


def wide_event_middleware(app, config):
    """Wrap the complete ASGI app, outside its error-to-response middleware."""
    async def middleware(scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        start = config.clock()
        event = deepcopy(config.deployment)
        scope["wide_event"] = event
        scope["wide_event_bodies"] = {}
        incoming = _headers(scope.get("headers", []), ("x-request-id",)).get("x-request-id")
        request_id = (incoming if config.trust_request_id and type(incoming) is str
                      and _ID.fullmatch(incoming) else uuid4().hex)
        # Correlation must be available while handlers enqueue related work.
        event.update(service=config.service, env=config.env, request_id=request_id,
                     method=scope["method"])
        request_headers = scope.get("headers", [])
        response_headers = []
        status = None
        completed = False
        disconnected = False
        request_stream = response_stream = trailers = False
        end = stamp = None

        def terminal():
            nonlocal end, stamp
            if end is None:  # First terminal hook wins; later hooks cannot reset timing.
                end, stamp = config.clock(), _timestamp()

        async def observed_receive():
            nonlocal disconnected, request_stream
            message = await receive()
            if message["type"] == "http.disconnect" and not completed:
                disconnected = True
                terminal()
            if message["type"] == "http.request" and message.get("more_body", False):
                request_stream = True
            return message

        async def observed_send(message):
            nonlocal status, completed, response_headers, response_stream, trailers
            if completed:
                return await send(message)  # ASGI ignores sends after completion.
            kind = message["type"]
            outgoing = message
            if kind == "http.response.start":
                # Copy before adding the correlation header; never sanitize wire data.
                headers = [(key, value) for key, value in message.get("headers", [])
                           if key.lower() != b"x-request-id"]
                headers.append((b"x-request-id", request_id.encode("ascii")))
                outgoing = {**message, "headers": headers}
            try:
                await send(outgoing)
            except OSError as error:
                event["error"] = error
                terminal()
                raise
            if kind == "http.response.start":
                status, response_headers = message["status"], outgoing["headers"]
                trailers = message.get("trailers", False)
            elif kind == "http.response.body":
                response_stream |= message.get("more_body", False)
                if not message.get("more_body", False) and not trailers:
                    completed = not disconnected
                    terminal()
            elif kind == "http.response.trailers" and not message.get("more_trailers", False):
                completed = not disconnected
                terminal()

        try:
            await app(scope, observed_receive, observed_send)
        except BaseException as error:
            event["error"] = error
            raise
        finally:
            terminal()
            # Every logging-only operation stays behind this failure boundary.
            try:
                if not completed and event.get("error") is None:
                    event["error"] = {"name": "ResponseIncomplete",
                                      "message": "ASGI response completion not observed"}
                core = {"service": config.service, "env": config.env,
                        "request_id": request_id, "method": scope["method"],
                        "duration_ms": _timing(config, start, end), "timestamp": stamp}
                if status is not None:
                    core["status_code"] = status
                else:
                    event.pop("status_code", None)
                path = scope.get("path", "").split("?", 1)[0].split("#", 1)[0]
                path = config.path_projector(path) if config.path_projector else path
                event.pop("path", None)
                if path is not None:
                    core["path"] = path
                request = {"headers": _headers(request_headers, config.request_headers)}
                response = {"headers": _headers(response_headers, config.response_headers)}
                route = getattr(scope.get("route"), "path", None)
                if route is not None:
                    request["route"] = route
                params = scope.get("path_params", {})
                params = {key: params[key] for key in config.param_fields if key in params}
                if params:
                    request["params"] = params
                query = scope.get("query_string", b"")
                if config.query_fields and len(query) <= 8192:
                    try:
                        query = _pairs(parse_qsl(query.decode("utf-8", "replace"),
                                                keep_blank_values=True, max_num_fields=128),
                                       config.query_fields)
                    except ValueError:
                        query = {}
                        _health(config, "query_capture_skipped")
                    # OAuth query code/state are secrets; error.code remains useful.
                    for key in query:
                        if _name(key) in ("code", "state"):
                            query[key] = ([REDACTED] * len(query[key])
                                          if type(query[key]) is list else REDACTED)
                    if query:
                        request["query"] = query
                policy = config.body_fields.get(scope.get("path"), {})
                for side, group, headers, streaming in (
                    ("request", request, request_headers, request_stream),
                    ("response", response, response_headers, response_stream),
                ):
                    fields = policy.get(side)
                    if fields is None:
                        group["body_capture"] = "disabled"
                        continue
                    content_type = _headers(headers, ("content-type",)).get("content-type", "")
                    projection = scope["wide_event_bodies"].get(side)
                    if (streaming or type(content_type) is not str
                        or content_type.split(";", 1)[0].strip().lower() != "application/json"
                        or type(projection) is not dict):
                        continue  # Enabled but unobservable/unsupported is unknown.
                    group["body"] = {key: projection[key] for key in fields if key in projection}
                event.update(core, request=request, response=response)
                _complete(event, config, successful=completed and status is not None
                          and 200 <= status < 400)
            except Exception:
                _health(config, "http_finalization_failed")
    return middleware


async def wide_event_worker(handler, event, config, *, job_metadata,
                            confirmed_recovery=False):
    """Our worker adaptation. Metadata/recovery must come from the queue adapter.

    handler(event) may include the broker completion/ack step if that is the
    chosen boundary. Otherwise this measures handler execution only.
    confirmed_recovery: queue fact, or zero-argument synchronous callback evaluated
    after handler success. A retry index alone is never completion evidence.
    """
    start = config.clock()
    successful = False
    metadata = deepcopy(job_metadata)
    http_fields = ("method", "path", "status_code", "request", "response")
    for key in http_fields:
        metadata.pop(key, None)
        event.pop(key, None)
    try:
        for key, value in deepcopy(config.deployment).items():
            event.setdefault(key, value)
        event.update(metadata)
        result = await handler(event)
        successful = True
        return result
    except BaseException as error:
        event["error"] = error
        raise
    finally:
        try:
            for key in http_fields:
                event.pop(key, None)
            event.update(metadata)
            event.update(service=config.service, env=config.env, timestamp=_timestamp(),
                         duration_ms=_timing(config, start))
            recovered = False
            if successful and event.get("error") is None:
                try:
                    recovered = bool(confirmed_recovery() if callable(confirmed_recovery)
                                     else confirmed_recovery)
                except Exception:
                    _health(config, "recovery_confirmation_failed")
            _complete(event, config, successful=successful, confirmed_recovery=recovered,
                      job_keys=tuple(metadata))
        except Exception:
            _health(config, "worker_finalization_failed")
