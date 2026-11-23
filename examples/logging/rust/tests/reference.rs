use axum::{
    body::{Body, Bytes},
    extract::{Extension, Json, Path},
    http::{Request, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use http_body::{Body as HttpBody, Frame};
use http_body_util::BodyExt;
use quiet_wide_event_example::{
    error_json,
    http::{wide_event_middleware, Capture, HttpConfig, Projections},
    sanitized_event, should_sample,
    worker::{wide_event_worker, QueueCompletion, QueueFacts},
    Completion, Config, Event, SharedEvent,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    future::{pending, poll_fn, Future},
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::Duration,
};
use tower::ServiceExt;

type Lines = Arc<Mutex<Vec<Value>>>;

fn setup() -> (Config, Lines, Arc<AtomicUsize>) {
    let lines: Lines = Arc::default();
    let sink = lines.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let measured = count.clone();
    let mut config = Config::new(
        "test-api",
        "test",
        Arc::new(move |line| {
            // The actual sink parses every bounded UTF-8 JSON line.
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(line).unwrap());
            Ok(())
        }),
    );
    config.measure = Arc::new(move |_, _| {
        measured.fetch_add(1, Ordering::SeqCst);
    });
    (config, lines, count)
}

fn app(router: Router, config: HttpConfig) -> Router {
    config.logging.validate().unwrap();
    router.layer(middleware::from_fn_with_state(
        Arc::new(config),
        wide_event_middleware,
    ))
}

async fn consume(response: Response) -> Bytes {
    response.into_body().collect().await.unwrap().to_bytes()
}

fn request(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}
fn object(value: Value) -> Event {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn actual_status_errors_handled_redirect_and_metadata_ownership() {
    let (mut config, lines, count) = setup();
    config.sample_rate = 0.0;
    config.slow_ms = Some(0.0); // Every completed success is exactly/above the threshold.
    let router = app(
        Router::new()
            .route(
                "/bad",
                get(|| async { (StatusCode::UNPROCESSABLE_ENTITY, "invalid") }),
            )
            .route(
                "/redirect",
                get(|Extension(event): Extension<SharedEvent>| async move {
                    let mut event = event.lock().unwrap();
                    assert!(event["request_id"].as_str().is_some_and(|s| !s.is_empty()));
                    assert_eq!(event["method"], "GET");
                    event.insert("error".into(), json!("exchange failed"));
                    event.insert("status_code".into(), json!(999));
                    event.insert("request_id".into(), json!("forged"));
                    event.insert("service".into(), json!("forged"));
                    event.insert("timestamp".into(), json!("forged"));
                    event.insert("flow".into(), json!("sign_in"));
                    (StatusCode::FOUND, "redirect")
                }),
            )
            .route("/ok", get(|| async { "ok" })),
        HttpConfig::new(Arc::new(config)),
    );
    for (path, status) in [
        ("/bad?password=secret", 422),
        ("/redirect", 302),
        ("/missing", 404),
        ("/ok", 200),
    ] {
        let response = router.clone().oneshot(request(path)).await.unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert_ne!(response.headers()["x-request-id"], "forged");
        consume(response).await;
    }
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 4);
    assert_eq!(count.load(Ordering::SeqCst), 4);
    assert_eq!(lines[0]["path"], "/bad");
    assert_eq!(lines[0]["status_code"], 422);
    assert_eq!(lines[1]["status_code"], 302);
    assert_eq!(lines[1]["error"]["message"], "exchange failed");
    assert_eq!(lines[1]["flow"], "sign_in");
    assert_eq!(lines[1]["service"], "test-api");
    assert!(lines[1]["timestamp"].as_str().unwrap().ends_with('Z'));
    assert!(chrono::DateTime::parse_from_rfc3339(lines[1]["timestamp"].as_str().unwrap()).is_ok());
    assert!(lines[..3].iter().all(|v| v["level"] == "error"));
    assert_eq!(lines[3]["level"], "warn");
    assert!(lines[3]["duration_ms"].as_f64().unwrap() >= 0.0);
    assert_eq!(lines[3]["request"]["body_capture"], "disabled");
}

#[test]
fn sampling_exact_boundaries_scope_and_defaults() {
    let (mut config, _, _) = setup();
    let mut event = object(json!({"status_code": 200, "duration_ms": 10.0}));
    let success = Completion {
        successful: true,
        ..Default::default()
    };
    assert!(should_sample(&event, success, &config, 0.999999));
    config.sample_rate = 0.0;
    config.slow_ms = Some(10.0);
    assert!(should_sample(&event, success, &config, 0.0));
    event.insert("duration_ms".into(), json!(9.999));
    assert!(!should_sample(&event, success, &config, 0.0));
    event.insert("duration_ms".into(), json!(11.0));
    assert!(!should_sample(&event, Completion::default(), &config, 0.0));
    config.slow_ms = None;
    config.slo_failure = Some(Arc::new(|event| {
        event.get("flow") == Some(&json!("critical")) && event.get("good") == Some(&json!(false))
    }));
    event.insert("flow".into(), json!("excluded"));
    event.insert("good".into(), json!(false));
    assert!(!should_sample(&event, success, &config, 0.0));
    event.insert("flow".into(), json!("critical"));
    assert!(should_sample(&event, success, &config, 0.0));
    event.insert("flow".into(), json!("excluded"));
    config.retain = Some(Arc::new(|event| event.get("audit") == Some(&json!(true))));
    event.insert("audit".into(), json!(true));
    assert!(should_sample(&event, success, &config, 0.0));
    config.sample_rate = f64::NAN;
    assert!(config.validate().is_err());
}

#[tokio::test]
async fn slo_and_business_retention_with_unsampled_measurement_before_sink() {
    let (mut config, lines, count) = setup();
    config.sample_rate = 0.0;
    config.slo_failure = Some(Arc::new(|e| e.get("flow") == Some(&json!("critical"))));
    config.retain = Some(Arc::new(|e| e.get("flow") == Some(&json!("audit"))));
    let original_sink = config.sink.clone();
    let count_at_sink = count.clone();
    config.sink = Arc::new(move |line| {
        assert!(count_at_sink.load(Ordering::SeqCst) > 0);
        original_sink(line)
    });
    let router = app(
        Router::new().route(
            "/{flow}",
            get(
                |Path(flow): Path<String>, Extension(event): Extension<SharedEvent>| async move {
                    event.lock().unwrap().insert("flow".into(), json!(flow));
                    "ok"
                },
            ),
        ),
        HttpConfig::new(Arc::new(config)),
    );
    for path in ["/ordinary", "/critical", "/audit"] {
        consume(router.clone().oneshot(request(path)).await.unwrap()).await;
    }
    assert_eq!(count.load(Ordering::SeqCst), 3);
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|e| e["level"] == "info"));
}

#[tokio::test]
async fn concurrent_requests_isolate_context_validate_ids_and_snapshot_once() {
    let (config, lines, _) = setup();
    let saved: Arc<Mutex<Vec<SharedEvent>>> = Arc::default();
    let handler_saved = saved.clone();
    let router = Router::new().route(
        "/{user}",
        get(
            move |Path(user): Path<String>, Extension(event): Extension<SharedEvent>| {
                let saved = handler_saved.clone();
                async move {
                    event
                        .lock()
                        .unwrap()
                        .insert("user".into(), json!({"id": user}));
                    saved.lock().unwrap().push(event.clone());
                    tokio::task::yield_now().await;
                    "done"
                }
            },
        ),
    );
    let mut http = HttpConfig::new(Arc::new(config));
    http.trust_request_id = true;
    let router = app(router, http.clone());
    let mut first = request("/alice");
    first
        .headers_mut()
        .insert("x-request-id", "trusted_1".parse().unwrap());
    let mut second = request("/bob");
    second
        .headers_mut()
        .insert("x-request-id", "malformed id".parse().unwrap());
    let (first, second) = tokio::join!(
        router.clone().oneshot(first),
        router.clone().oneshot(second)
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.headers()["x-request-id"], "trusted_1");
    assert_ne!(second.headers()["x-request-id"], "malformed id");
    assert_ne!(
        first.headers()["x-request-id"],
        second.headers()["x-request-id"]
    );
    consume(first).await;
    consume(second).await;
    for event in saved.lock().unwrap().iter() {
        event
            .lock()
            .unwrap()
            .insert("user".into(), json!("late write"));
    }
    {
        let logged = lines.lock().unwrap();
        assert_eq!(logged.len(), 2);
        assert_eq!(logged[0]["user"]["id"], "alice");
        assert_eq!(logged[1]["user"]["id"], "bob");
    }
    http.trust_request_id = false;
    let router = app(Router::new().route("/", get(|| async { "ok" })), http);
    let mut input = request("/");
    input
        .headers_mut()
        .insert("x-request-id", "untrusted".parse().unwrap());
    let response = router.oneshot(input).await.unwrap();
    assert_ne!(response.headers()["x-request-id"], "untrusted");
    consume(response).await;
}

/// A controllable streaming body: frames, trailers, errors, then optional pending.
struct TestBody {
    frames: VecDeque<Result<Frame<Bytes>, io::Error>>,
    pending: bool,
}
impl HttpBody for TestBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if let Some(frame) = self.frames.pop_front() {
            Poll::Ready(Some(frame))
        } else if self.pending {
            Poll::Pending
        } else {
            Poll::Ready(None)
        }
    }
}
fn stream(frames: Vec<Result<Frame<Bytes>, io::Error>>, pending: bool) -> Body {
    Body::new(TestBody {
        frames: frames.into(),
        pending,
    })
}

#[tokio::test]
async fn streaming_completion_trailers_error_drop_and_duplicate_finalize_guard() {
    let (mut config, lines, count) = setup();
    config.sample_rate = 0.0;
    config.slow_ms = Some(0.0);
    let router = app(
        Router::new()
            .route(
                "/stream",
                get(|| async {
                    let mut trailers = axum::http::HeaderMap::new();
                    trailers.insert("x-check", "yes".parse().unwrap());
                    Response::new(stream(
                        vec![
                            Ok(Frame::data(Bytes::from_static(b"one"))),
                            Ok(Frame::trailers(trailers)),
                        ],
                        false,
                    ))
                }),
            )
            .route(
                "/drop",
                get(|| async {
                    Response::new(stream(
                        vec![Ok(Frame::data(Bytes::from_static(b"one")))],
                        true,
                    ))
                }),
            )
            .route(
                "/error",
                get(|| async {
                    Response::new(stream(
                        vec![Err(io::Error::other("native stream failure"))],
                        false,
                    ))
                }),
            )
            .route("/empty", get(|| async { StatusCode::NO_CONTENT })),
        HttpConfig::new(Arc::new(config)),
    );
    let response = router.clone().oneshot(request("/stream")).await.unwrap();
    assert!(lines.lock().unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let mut body = response.into_body();
    assert_eq!(
        body.frame().await.unwrap().unwrap().into_data().unwrap(),
        Bytes::from_static(b"one")
    );
    assert!(lines.lock().unwrap().is_empty());
    assert_eq!(
        body.frame()
            .await
            .unwrap()
            .unwrap()
            .into_trailers()
            .unwrap()["x-check"],
        "yes"
    );
    assert!(body.frame().await.is_none());
    assert!(body.frame().await.is_none());
    drop(body);
    assert_eq!(lines.lock().unwrap().len(), 1);
    assert!(lines.lock().unwrap()[0]["duration_ms"].as_f64().unwrap() >= 10.0);
    assert!(lines.lock().unwrap()[0].get("error").is_none());
    let mut body = router
        .clone()
        .oneshot(request("/drop"))
        .await
        .unwrap()
        .into_body();
    assert!(body.frame().await.is_some());
    drop(body);
    assert_eq!(lines.lock().unwrap()[1]["error"]["reason"], "dropped");
    assert_eq!(lines.lock().unwrap()[1]["status_code"], 200);
    assert_eq!(lines.lock().unwrap()[1]["level"], "error");
    let mut body = router
        .clone()
        .oneshot(request("/error"))
        .await
        .unwrap()
        .into_body();
    assert!(body.frame().await.unwrap().is_err());
    drop(body);
    assert_eq!(
        lines.lock().unwrap()[2]["error"]["message"],
        "native stream failure"
    );
    consume(router.oneshot(request("/empty")).await.unwrap()).await;
    assert_eq!(lines.lock().unwrap().len(), 4);
    assert_eq!(count.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn handler_future_drop_and_panic_have_no_fabricated_status() {
    let (mut config, lines, _) = setup();
    config.sample_rate = 0.0;
    let router = app(
        Router::new()
            .route(
                "/pending",
                get(|| async {
                    pending::<()>().await;
                    "unreachable"
                }),
            )
            .route(
                "/panic",
                get(|| async {
                    panic!("private panic payload");
                    #[allow(unreachable_code)]
                    "unreachable"
                }),
            ),
        HttpConfig::new(Arc::new(config)),
    );
    let mut future = Box::pin(router.clone().oneshot(request("/pending")));
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(future);
    let task = tokio::spawn(async move { router.oneshot(request("/panic")).await });
    assert!(task.await.unwrap_err().is_panic());
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 2);
    for event in lines.iter() {
        assert!(event.get("status_code").is_none());
        assert_eq!(event["level"], "error");
        assert!(!event.to_string().contains("private panic payload"));
    }
}

#[tokio::test]
async fn approved_projections_redaction_repeated_fields_and_unchanged_application_body() {
    let (mut config, lines, _) = setup();
    config.sensitive_fields.insert("internal-pin".into());
    let router = Router::new().route("/orders/{id}", post(|Extension(event): Extension<SharedEvent>, Extension(projected): Extension<Arc<Mutex<Projections>>>, Json(input): Json<Value>| async move {
        event.lock().unwrap().insert("customer".into(), json!({"email": "a@example.test", "msisdn": "+233123", "INTERNAL_PIN": "custom-sentinel", "nested": [{"Access_Token": "nested-sentinel"}]}));
        let mut projected = projected.lock().unwrap();
        projected.request_body = Some(input.clone());
        projected.query = Some(object(json!({"tag": ["one", "two"], "code": ["oauth-sentinel", "oauth-sentinel2"], "unapproved": "hidden"})));
        projected.params = Some(object(json!({"id": "public-id"})));
        let mut response = Json(input).into_response();
        response.headers_mut().append("set-cookie", "session=cookie-sentinel".parse().unwrap());
        response.headers_mut().insert("location", "/next?code=url-sentinel".parse().unwrap());
        response.extensions_mut().insert(Projections { response_body: Some(json!({"accepted": true, "password": "response-sentinel"})), ..Default::default() });
        response
    }));
    let mut http = HttpConfig::new(Arc::new(config));
    http.request_headers
        .extend(["authorization".into(), "x-label".into()]);
    http.response_headers
        .extend(["set-cookie".into(), "location".into()]);
    http.path = Arc::new(|_| Some("/orders/[id]".into()));
    http.capture.insert(
        "/orders/{id}".into(),
        Capture {
            request_body_fields: Some(vec!["allowed".into(), "password".into()]),
            response_body_fields: Some(vec!["accepted".into(), "password".into()]),
            query_fields: vec!["tag".into(), "code".into()],
            param_fields: vec!["id".into()],
        },
    );
    let router = app(router, http);
    let input = json!({"allowed": {"refresh-token": "refresh-sentinel", "email": "b@example.test"}, "password": "request-sentinel", "unapproved": "application-only"});
    let mut request = Request::builder()
        .method("POST")
        .uri("/orders/path-sentinel?code=raw-query-sentinel")
        .header("content-type", "application/json")
        .header("Authorization", "Bearer header-sentinel")
        .body(Body::from(input.to_string()))
        .unwrap();
    request
        .headers_mut()
        .append("x-label", "first".parse().unwrap());
    request
        .headers_mut()
        .append("x-label", "second".parse().unwrap());
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.headers()["set-cookie"], "session=cookie-sentinel");
    assert_eq!(
        serde_json::from_slice::<Value>(&consume(response).await).unwrap(),
        input
    );
    let logged = lines.lock().unwrap();
    let event = &logged[0];
    let line = event.to_string();
    for sentinel in [
        "custom-sentinel",
        "nested-sentinel",
        "refresh-sentinel",
        "response-sentinel",
        "request-sentinel",
        "header-sentinel",
        "cookie-sentinel",
        "url-sentinel",
        "path-sentinel",
        "raw-query-sentinel",
        "oauth-sentinel",
        "application-only",
    ] {
        assert!(!line.contains(sentinel), "leaked {sentinel}");
    }
    assert_eq!(
        event["request"]["headers"]["x-label"],
        json!(["first", "second"])
    );
    assert_eq!(
        event["request"]["query"]["code"],
        json!(["[REDACTED]", "[REDACTED]"])
    );
    assert_eq!(event["request"]["query"]["tag"], json!(["one", "two"]));
    assert_eq!(event["customer"]["email"], "a@example.test");
    assert_eq!(event["customer"]["msisdn"], "+233123");
    assert_eq!(
        event["request"]["body"]["allowed"]["email"],
        "b@example.test"
    );
    assert!(event["request"].get("body_capture").is_none());
    assert_eq!(event["response"]["body"]["password"], "[REDACTED]");
}

#[test]
fn bounds_valid_utf8_json_redaction_markers_deep_values_and_rejected_minimum() {
    let (mut config, _, _) = setup();
    config.body_limit = 128;
    config.event_limit = 2048;
    let mut event = object(
        json!({"request_id": "id", "flow": "test", "status_code": 503, "duration_ms": 1.0, "error": {"code": "FAIL", "message": "failed"}, "request": {"body": {"password": "sentinel", "text": "é🦀".repeat(5000)}}, "response": {"body_capture": "disabled"}}),
    );
    let safe = sanitized_event(&event, &config).unwrap();
    let encoded = serde_json::to_vec(&safe).unwrap();
    assert!(encoded.len() <= 2048);
    assert!(serde_json::from_slice::<Value>(&encoded).is_ok());
    assert_eq!(safe["request"]["body_capture"], "truncated");
    assert_eq!(safe["request"]["body"]["password"], "[REDACTED]");
    assert!(serde_json::to_vec(&safe["request"]["body"]).unwrap().len() <= 128);
    for n in 0..60 {
        event.insert(format!("extra_{n}"), json!("x".repeat(4096)));
    }
    let safe = sanitized_event(&event, &config).unwrap();
    assert!(serde_json::to_vec(&safe).unwrap().len() <= 2048);
    assert_eq!(safe["flow"], "test");
    assert_eq!(safe["error"]["code"], "FAIL");
    assert_eq!(safe["request_id"], "id");
    let mut deep = json!("secret");
    for _ in 0..40 {
        deep = json!({"next": deep});
    }
    event.insert("deep".into(), deep);
    assert!(sanitized_event(&event, &config).is_some());
    let mut expanded_error = object(
        json!({"message": "preserved message", "code": "PRESERVED", "name": "ProviderError"}),
    );
    for n in 0..100 {
        expanded_error.insert(format!("aaa{n}"), json!({"details": "x".repeat(1000)}));
    }
    event.insert("error".into(), Value::Object(expanded_error));
    let safe = sanitized_event(&event, &config).unwrap();
    assert_eq!(safe["error"]["message"], "preserved message");
    assert_eq!(safe["error"]["code"], "PRESERVED");
    event.insert("flow".into(), json!("x".repeat(4096)));
    config.event_limit = 512;
    assert!(sanitized_event(&event, &config).is_none());
}

#[tokio::test]
async fn sink_errors_panics_and_callback_failures_preserve_http_result() {
    for panics in [false, true] {
        let (mut config, _, count) = setup();
        config.sink = Arc::new(move |_| {
            if panics {
                panic!("sink unavailable")
            } else {
                Err(io::Error::other("unavailable"))
            }
        });
        let failures = config.logging_failures.clone();
        let router = app(
            Router::new().route("/", get(|| async { (StatusCode::ACCEPTED, "accepted") })),
            HttpConfig::new(Arc::new(config)),
        );
        let response = router.oneshot(request("/")).await.unwrap();
        assert_eq!(response.status(), 202);
        assert_eq!(consume(response).await, "accepted");
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    let (mut config, lines, _) = setup();
    config.sample_rate = 0.0;
    config.measure = Arc::new(|_, _| panic!("metrics unavailable"));
    config.retain = Some(Arc::new(|_| panic!("policy unavailable")));
    let failures = config.logging_failures.clone();
    let router = app(
        Router::new().route("/", get(|| async { "ok" })),
        HttpConfig::new(Arc::new(config)),
    );
    assert_eq!(
        consume(router.oneshot(request("/")).await.unwrap()).await,
        "ok"
    );
    assert_eq!(lines.lock().unwrap().len(), 1);
    assert_eq!(failures.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn worker_real_facts_failures_first_success_and_confirmed_recovery_at_zero_rate() {
    let (mut config, lines, count) = setup();
    config.sample_rate = 0.0;
    let config = Arc::new(config);
    // Deliberately unusual native attempt tokens; no interpretation of their numbering.
    for (attempt, fail, evidence) in [
        (
            "initial-native-token",
            false,
            QueueCompletion::Successful { after_retry: false },
        ),
        ("next-native-token", true, QueueCompletion::Unknown),
        ("unconfirmed-token", false, QueueCompletion::Unknown),
        (
            "recovered-native-token",
            false,
            QueueCompletion::Successful { after_retry: true },
        ),
    ] {
        let mut event = Event::new();
        let result = wide_event_worker(&mut event, QueueFacts { metadata: object(json!({"job_id": "native:job", "attempt": attempt, "request_id": "originating-http-id"})) }, config.clone(), async |event| {
            assert_eq!(event["job_id"], "native:job");
            assert_eq!(event["request_id"], "originating-http-id");
            event.insert("flow".into(), json!("deliver_order"));
            event.insert("job_id".into(), json!("forged"));
            if fail { Err(json!({"message": "provider unavailable", "code": "TEMPORARY", "details": {"retryable": true, "api_key": "worker-sentinel"}})) } else { Ok(42) }
        }, async |_| evidence).await;
        assert_eq!(result.is_err(), fail);
    }
    assert_eq!(count.load(Ordering::SeqCst), 4);
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["level"], "error");
    assert_eq!(lines[0]["attempt"], "next-native-token");
    assert_eq!(lines[0]["error"]["details"]["retryable"], true);
    assert_eq!(lines[0]["error"]["details"]["api_key"], "[REDACTED]");
    assert_eq!(lines[1]["level"], "info");
    assert_eq!(lines[1]["attempt"], "recovered-native-token");
    assert_eq!(lines[1]["job_id"], "native:job");
    assert_eq!(lines[1]["request_id"], "originating-http-id");
    assert!(lines
        .iter()
        .all(|e| e.get("method").is_none() && e.get("status_code").is_none()));
}

#[tokio::test]
async fn worker_slo_slow_drop_and_independent_job_have_no_invented_state() {
    let (mut config, lines, count) = setup();
    config.sample_rate = 0.0;
    config.slo_failure = Some(Arc::new(|e| {
        e.get("queue_wait_ms")
            .and_then(Value::as_u64)
            .is_some_and(|ms| ms >= 100)
    }));
    let config = Arc::new(config);
    let mut event = Event::new();
    wide_event_worker(
        &mut event,
        QueueFacts {
            metadata: object(json!({"job_id": "independent", "queue_wait_ms": 100})),
        },
        config.clone(),
        async |_| Ok(()),
        async |_| QueueCompletion::Unknown,
    )
    .await
    .unwrap();
    let mut future = Box::pin(wide_event_worker(
        &mut event,
        QueueFacts {
            metadata: object(json!({"job_id": "dropped"})),
        },
        config,
        async |_| {
            pending::<()>().await;
            Ok(())
        },
        async |_| QueueCompletion::Unknown,
    ));
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(future);
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert!(lines[0].get("request_id").is_none());
    assert_eq!(lines[0]["level"], "info");
    assert_eq!(lines[1]["error"]["name"], "LocalAttemptInterrupted");
    assert!(lines
        .iter()
        .all(|e| e.get("state").is_none() && e.get("parent_id").is_none()));
}

#[tokio::test]
async fn native_error_fields_text_scrubber_and_encoded_json_safety() {
    let (mut config, lines, _) = setup();
    config.text_policy = Some(Arc::new(|text| {
        Some(text.replace("free-text-sentinel", "[REDACTED]"))
    }));
    let mut event = object(
        json!({"encoded": "{\"password\":\"encoded-sentinel\"}", "details": {"phone": "+233123"}}),
    );
    let native = io::Error::other("native free-text-sentinel");
    let expected = error_json(
        &native,
        object(json!({"code": "NATIVE", "retryable": true})),
    );
    let result: Result<(), Value> = wide_event_worker(
        &mut event,
        QueueFacts {
            metadata: object(json!({"job_id": "native"})),
        },
        Arc::new(config),
        async |_| Err(expected),
        async |_| QueueCompletion::Unknown,
    )
    .await;
    assert!(result.is_err());
    let lines = lines.lock().unwrap();
    let event = &lines[0];
    assert_eq!(event["error"]["message"], "native [REDACTED]");
    assert_eq!(event["error"]["code"], "NATIVE");
    assert_eq!(event["error"]["retryable"], true);
    assert!(!event.to_string().contains("encoded-sentinel"));
    assert_eq!(event["details"]["phone"], "+233123");
}

#[tokio::test]
async fn skipped_stream_capture_head_and_upgrade_boundaries_are_explicit() {
    let (config, lines, _) = setup();
    let router = Router::new()
        .route(
            "/stream",
            get(|| async {
                let mut response = Response::new(stream(
                    vec![Ok(Frame::data(Bytes::from_static(b"data")))],
                    false,
                ));
                response
                    .headers_mut()
                    .insert("content-type", "application/json".parse().unwrap());
                response.extensions_mut().insert(Projections {
                    response_body: Some(json!({"field": "must-skip"})),
                    ..Default::default()
                });
                response
            }),
        )
        .route("/head", get(|| async { "body exists in handler" }))
        .route(
            "/upgrade",
            get(|| async { StatusCode::SWITCHING_PROTOCOLS }),
        );
    let mut http = HttpConfig::new(Arc::new(config));
    http.capture.insert(
        "/stream".into(),
        Capture {
            request_body_fields: Some(vec!["field".into()]),
            response_body_fields: Some(vec!["field".into()]),
            ..Default::default()
        },
    );
    let router = app(router, http);
    assert_eq!(
        consume(router.clone().oneshot(request("/stream")).await.unwrap()).await,
        "data"
    );
    let head = Request::builder()
        .method("HEAD")
        .uri("/head")
        .body(Body::empty())
        .unwrap();
    assert!(consume(router.clone().oneshot(head).await.unwrap())
        .await
        .is_empty());
    consume(router.oneshot(request("/upgrade")).await.unwrap()).await;
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 3);
    assert!(lines[0]["response"].get("body").is_none());
    assert!(lines[0]["response"].get("body_capture").is_none());
    assert!(lines[0]["request"].get("body_capture").is_none());
    assert!(lines[1].get("error").is_none());
    assert_eq!(lines[1]["level"], "info");
    assert_eq!(lines[2]["error"]["reason"], "unsupported_upgrade");
    assert_eq!(lines[2]["level"], "error");
    assert_eq!(lines[2]["status_code"], 101);
}

#[tokio::test]
async fn oversized_events_reject_safely_but_still_measure_and_keep_results() {
    let (mut config, lines, count) = setup();
    config.event_limit = 512;
    let failures = config.logging_failures.clone();
    let router = app(
        Router::new().route(
            "/",
            get(|Extension(event): Extension<SharedEvent>| async move {
                event
                    .lock()
                    .unwrap()
                    .insert("flow".into(), json!("x".repeat(5000)));
                "application succeeded"
            }),
        ),
        HttpConfig::new(Arc::new(config)),
    );
    assert_eq!(
        consume(router.oneshot(request("/")).await.unwrap()).await,
        "application succeeded"
    );
    assert!(lines.lock().unwrap().is_empty());
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(failures.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn worker_slow_error_priority_and_confirmation_time_boundary() {
    let (mut config, lines, _) = setup();
    config.sample_rate = 0.0;
    config.slow_ms = Some(0.0);
    config
        .deployment
        .insert("version".into(), json!("reference"));
    let config = Arc::new(config);
    let mut event = Event::new();
    wide_event_worker(
        &mut event,
        QueueFacts {
            metadata: object(json!({"job_id": "slow", "attempt": 0})),
        },
        config.clone(),
        async |_| Ok(()),
        async |_| {
            tokio::time::sleep(Duration::from_millis(30)).await;
            QueueCompletion::Unknown
        },
    )
    .await
    .unwrap();
    let result: Result<(), Value> = wide_event_worker(
        &mut event,
        QueueFacts {
            metadata: object(json!({"job_id": "failed", "attempt": 0})),
        },
        config,
        async |_| Err(json!("failed attempt")),
        async |_| QueueCompletion::Successful { after_retry: true },
    )
    .await;
    assert!(result.is_err());
    let lines = lines.lock().unwrap();
    assert_eq!(lines[0]["level"], "warn");
    assert!(lines[0]["duration_ms"].as_f64().unwrap() < 30.0);
    assert_eq!(lines[0]["version"], "reference");
    assert_eq!(lines[1]["level"], "error");
    assert_eq!(lines[1]["error"]["message"], "failed attempt");
}

#[tokio::test]
async fn worker_panic_and_sink_failure_keep_original_application_result() {
    let (mut config, lines, count) = setup();
    config.sample_rate = 0.0;
    let config = Arc::new(config);
    let task = tokio::spawn(async move {
        let mut event = Event::new();
        wide_event_worker(
            &mut event,
            QueueFacts {
                metadata: object(json!({"job_id": "panic"})),
            },
            config,
            async |_| {
                panic!("private native payload");
                #[allow(unreachable_code)]
                Ok(())
            },
            async |_| QueueCompletion::Unknown,
        )
        .await
    });
    assert!(task.await.unwrap_err().is_panic());
    assert_eq!(lines.lock().unwrap().len(), 1);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(!lines.lock().unwrap()[0]
        .to_string()
        .contains("private native payload"));
    let (mut config, _, count) = setup();
    config.sink = Arc::new(|_| Err(io::Error::other("unavailable")));
    let failures = config.logging_failures.clone();
    let mut event = Event::new();
    let value = wide_event_worker(
        &mut event,
        QueueFacts {
            metadata: object(json!({"job_id": "ok"})),
        },
        Arc::new(config),
        async |_| Ok(73),
        async |_| QueueCompletion::Unknown,
    )
    .await
    .unwrap();
    assert_eq!(value, 73);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(failures.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn scrubber_failure_rejects_log_but_measures_unclassified_coverage() {
    let (mut config, lines, count) = setup();
    config.text_policy = Some(Arc::new(|_| panic!("scrubber unavailable")));
    let measured = count.clone();
    config.measure = Arc::new(move |event, completion| {
        assert!(!completion.context_available);
        assert_eq!(event.get("status_code"), Some(&json!(200)));
        assert!(event.get("user").is_none());
        measured.fetch_add(1, Ordering::SeqCst);
    });
    let failures = config.logging_failures.clone();
    let router = app(
        Router::new().route("/", get(|| async { "ok" })),
        HttpConfig::new(Arc::new(config)),
    );
    assert_eq!(
        consume(router.oneshot(request("/")).await.unwrap()).await,
        "ok"
    );
    assert_eq!(failures.load(Ordering::SeqCst), 1);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn oversized_text_is_omitted_before_custom_scrubbing() {
    let (mut config, _, _) = setup();
    let secret = format!("sensitive-{}", "x".repeat(5000));
    let match_secret = secret.clone();
    config.text_policy = Some(Arc::new(move |value| {
        Some(value.replace(&match_secret, "[REDACTED]"))
    }));
    let safe = sanitized_event(&object(json!({"note": secret})), &config).unwrap();
    assert_eq!(safe["note"], "[OMITTED: text limit]");
}
