use axum::{
    extract::{Extension, Json},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Router,
};
use quiet_wide_event_example::{
    http::{wide_event_middleware, Capture, HttpConfig, Projections},
    stdout_json_sink,
    worker::{wide_event_worker, QueueCompletion, QueueFacts},
    Config, Event, SharedEvent,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

async fn order(
    Extension(event): Extension<SharedEvent>,
    Extension(projected): Extension<Arc<Mutex<Projections>>>,
    Json(input): Json<Value>,
) -> Response {
    {
        let mut event = event.lock().unwrap();
        event.insert("flow".into(), json!("create_order"));
        event.insert("order".into(), json!({"id": "ord_example"}));
    }
    // Observe already-parsed application data. Never read a body stream for logging.
    projected.lock().unwrap().request_body = Some(json!({
        "item_count": input.get("item_count"), "currency": input.get("currency")
    }));
    let output = json!({"order_id": "ord_example", "accepted": true});
    let mut response = (StatusCode::CREATED, Json(output)).into_response();
    response.extensions_mut().insert(Projections {
        response_body: Some(json!({"order_id": "ord_example"})),
        ..Default::default()
    });
    response
}

async fn failed_redirect(Extension(event): Extension<SharedEvent>) -> Redirect {
    let mut event = event.lock().unwrap();
    event.insert("flow".into(), json!("sign_in"));
    event.insert(
        "error".into(),
        json!({"code": "TOKEN_EXCHANGE_FAILED", "message": "Identity provider exchange failed"}),
    );
    Redirect::temporary("/ready")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Startup configuration shared by every unit in this demo process.
    let mut logging = Config::new("orders-example", "development", stdout_json_sink());
    if let Ok(rate) = std::env::var("SAMPLE_RATE") {
        logging.sample_rate = rate.parse()?;
    }
    logging.validate()?;
    let logging = Arc::new(logging);
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "worker") {
        let metadata: Event =
            serde_json::from_str(args.get(1).ok_or("supply queue-native metadata JSON")?)?;
        let confirmed = args
            .get(2)
            .is_some_and(|arg| arg == "confirmed-success-after-retry");
        let mut event = Event::new();
        wide_event_worker(
            &mut event,
            QueueFacts { metadata },
            logging,
            async |event| {
                event.insert("flow".into(), json!("deliver_order"));
                event.insert("order".into(), json!({"id": "ord_example"}));
                Ok(())
            },
            async |_| {
                if confirmed {
                    QueueCompletion::Successful { after_retry: true }
                } else {
                    QueueCompletion::Unknown
                }
            },
        )
        .await
        .map_err(|_| "demo attempt failed")?;
        return Ok(());
    }
    let mut http = HttpConfig::new(logging);
    http.response_headers.push("location".into());
    http.capture.insert(
        "/orders".into(),
        Capture {
            request_body_fields: Some(vec!["item_count".into(), "currency".into()]),
            response_body_fields: Some(vec!["order_id".into()]),
            ..Default::default()
        },
    );
    let app = Router::new()
        .route("/ready", get(|| async { "ready" }))
        .route("/orders", post(order))
        .route("/failed-redirect", get(failed_redirect))
        .layer(middleware::from_fn_with_state(
            Arc::new(http),
            wide_event_middleware,
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
    eprintln!("HTTP demo: http://127.0.0.1:3000 (JSON completion events on stdout)");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
