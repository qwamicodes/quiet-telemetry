// Run with -mode http (default) or -mode worker. No external queue is required.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync/atomic"

	logging "quiet.example/logging"
)

func main() {
	mode := flag.String("mode", "http", "http or worker")
	address := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	rate := flag.Float64("sample-rate", 1, "ordinary diagnostic retention rate, 0..1")
	flag.Parse()
	var measured, bad atomic.Uint64
	logger, err := logging.New(logging.Config{
		Service: "orders-demo", Env: "local", Sink: logging.JSONLineSink(os.Stdout),
		Sampling: logging.Sampling{Rate: rate,
			// Example user-supplied criterion: only create_order is eligible; good is
			// a locally completed HTTP 201 without error. No aggregate target is assumed.
			SLOFailure: func(e logging.Event, o logging.Observation) bool {
				return e["flow"] == "create_order" && (!o.ResponseCompleted || e["status_code"] != int64(201) || e["error"] != nil)
			},
		},
		Measure: func(e logging.Event, o logging.Observation) {
			// Replace with unsampled bounded-label counters/histograms in a real app.
			measured.Add(1)
			if e["flow"] == "create_order" && (!o.ResponseCompleted || e["status_code"] != int64(201) || e["error"] != nil) {
				bad.Add(1)
			}
		},
		HTTP: logging.HTTPConfig{
			RequestHeaders: []string{"Content-Type"}, ResponseHeaders: []string{"Content-Type", "X-Request-ID"},
			Metadata: func(r *http.Request) logging.Event { return logging.Event{"route": r.Pattern} },
			// Default remains OFF in the module; this demo opts in only for a successful,
			// non-streaming /orders response and projects an approved ID.
			ResponseBody: func(r *http.Request, e logging.Event) (any, bool) {
				if r.URL.Path == "/orders" && e["error"] == nil {
					if order, ok := e["order"]; ok {
						return order, true
					}
				}
				return nil, false
			},
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	switch *mode {
	case "http":
		mux := http.NewServeMux()
		mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
			event := logging.EventFrom(r.Context())
			event["flow"] = "create_order"
			// Decode once for the application, with a bounded body. Never read it again for logging.
			var input struct {
				ItemCount int    `json:"item_count"`
				Email     string `json:"email"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
				event["error"] = "invalid order input"
				http.Error(w, "invalid order input", 400)
				return
			}
			event["user"] = logging.Event{"email": input.Email}
			event["cart"] = logging.Event{"item_count": input.ItemCount}
			event["order"] = logging.Event{"id": "ord_demo"}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(event["order"])
		})
		mux.HandleFunc("GET /handled", func(w http.ResponseWriter, r *http.Request) {
			logging.EventFrom(r.Context())["error"] = errors.New("identity provider unavailable")
			http.Redirect(w, r, "/sign-in", 302)
		})
		mux.HandleFunc("GET /panic", func(http.ResponseWriter, *http.Request) { panic(errors.New("demonstration failure")) })
		mux.HandleFunc("GET /measurements", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]uint64{"observations": measured.Load(), "bad_create_order": bad.Load(), "logging_failures": logger.Failures()})
		})
		fmt.Fprintln(os.Stderr, "listening on", *address)
		log.Fatal(http.ListenAndServe(*address, logger.WideEventMiddleware(mux)))
	case "worker":
		// These are explicitly synthetic fixture facts, not inferred queue conventions.
		// An actual adapter supplies the native IDs/attempts and broker confirmation.
		facts := []struct {
			id                  string
			attempt             string
			err                 error
			confirmedAfterRetry bool
		}{
			{"job_first", "native-first", nil, false},
			{"job_retry", "native-failed-attempt", errors.New("provider timeout"), false},
			{"job_retry", "native-next-attempt", nil, true},
		}
		for _, fact := range facts {
			event := logging.Event{"job": logging.Event{"id": fact.id, "attempt": fact.attempt}}
			_ = logger.RunJob(context.Background(), event, func(ctx context.Context, e logging.Event) error { e["flow"] = "send_receipt"; return fact.err }, func() bool { return fact.confirmedAfterRetry })
		}
		fmt.Fprintf(os.Stderr, "observations=%d logging_failures=%d\n", measured.Load(), logger.Failures())
	default:
		log.Fatal("unknown mode")
	}
}
