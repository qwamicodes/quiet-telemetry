package logging

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

type capture struct {
	mu    sync.Mutex
	lines [][]byte
}

func (c *capture) sink(p []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, append([]byte(nil), p...))
	return nil
}
func (c *capture) events(t *testing.T) []Event {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []Event{}
	for _, line := range c.lines {
		var e Event
		if !utf8.Valid(line) {
			t.Fatal("invalid UTF8")
		}
		if err := json.Unmarshal(line, &e); err != nil {
			t.Fatal(err)
		}
		out = append(out, e)
	}
	return out
}
func setup(t *testing.T, change func(*Config)) (*Logger, *capture) {
	t.Helper()
	c := &capture{}
	cfg := Config{Service: "test-api", Env: "test", Sink: c.sink}
	if change != nil {
		change(&cfg)
	}
	l, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return l, c
}
func TestHTTPActualStatusAndDirectEnrichment(t *testing.T) {
	for _, status := range []int{200, 201, 302, 422, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			l, c := setup(t, nil)
			before := time.Now()
			w := httptest.NewRecorder()
			l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				e := EventFrom(r.Context())
				e["flow"] = "create_order"
				e["user"] = Event{"email": "a@example.com", "msisdn": "123"}
				e["request_id"] = "forged"
				e["status_code"] = 999
				w.WriteHeader(status)
				w.WriteHeader(500)
				_, _ = w.Write([]byte("actual response"))
			})).ServeHTTP(w, httptest.NewRequest("GET", "/orders?token=SECRET", nil))
			events := c.events(t)
			if len(events) != 1 {
				t.Fatal(events)
			}
			e := events[0]
			if e["status_code"] != float64(status) || e["flow"] != "create_order" || e["path"] != "/orders" || e["request_id"] != w.Header().Get("X-Request-ID") || e["request_id"] == "forged" {
				t.Fatal(e)
			}
			expected := "info"
			if status >= 400 {
				expected = "error"
			}
			if e["level"] != expected {
				t.Fatal(e)
			}
			ts, err := time.Parse(time.RFC3339Nano, e["timestamp"].(string))
			if err != nil || ts.Before(before) || !strings.HasSuffix(e["timestamp"].(string), "Z") {
				t.Fatal(e)
			}
			if number(e["duration_ms"]) < 0 || e["request"].(map[string]any)["body_capture"] != "disabled" {
				t.Fatal(e)
			}
		})
	}
}
func TestRequestIDsAndConcurrentIsolation(t *testing.T) {
	l, c := setup(t, func(c *Config) { c.HTTP.TrustRequestID = true; c.Deployment = Event{"region": Event{"name": "west"}} })
	h := l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e := EventFrom(r.Context())
		e["flow"] = r.Header.Get("X-Request-ID")
		e["region"].(map[string]any)["name"] = e["flow"]
		w.WriteHeader(204)
	}))
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/", nil)
			r.Header.Set("X-Request-ID", fmt.Sprintf("req_%d", i))
			h.ServeHTTP(httptest.NewRecorder(), r)
		}(i)
	}
	wg.Wait()
	es := c.events(t)
	if len(es) != 40 {
		t.Fatal(len(es))
	}
	for _, e := range es {
		if e["request_id"] != e["flow"] || e["region"].(map[string]any)["name"] != e["flow"] {
			t.Fatal(e)
		}
	}
	for _, trust := range []bool{false, true} {
		l, c = setup(t, func(c *Config) { c.HTTP.TrustRequestID = trust })
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("X-Request-ID", "bad id")
		l.WideEventMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(httptest.NewRecorder(), r)
		if c.events(t)[0]["request_id"] == "bad id" {
			t.Fatal("unvalidated ID")
		}
	}
}
func TestPanicAndHandledErrorActualServer(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			l, c := setup(t, nil)
			s := httptest.NewServer(l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if committed {
					w.WriteHeader(202)
					_, _ = w.Write([]byte("partial"))
					_ = http.NewResponseController(w).Flush()
				}
				panic(errors.New("dependency failed"))
			})))
			defer s.Close()
			response, err := s.Client().Get(s.URL)
			if err != nil {
				t.Fatal(err)
			}
			_, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if committed && readErr == nil {
				t.Fatal("committed panic must abort response")
			}
			expected := 500
			if committed {
				expected = 202
			}
			if response.StatusCode != expected {
				t.Fatal(response.StatusCode)
			}
			es := c.events(t)
			if len(es) != 1 || es[0]["status_code"] != float64(expected) || es[0]["level"] != "error" {
				t.Fatal(es)
			}
		})
	}
	l, c := setup(t, nil)
	w := httptest.NewRecorder()
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		EventFrom(r.Context())["error"] = "OAuth exchange failed"
		http.Redirect(w, r, "/sign-in", 302)
	})).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	e := c.events(t)[0]
	if e["level"] != "error" || e["status_code"] != float64(302) || e["error"].(map[string]any)["message"] != "OAuth exchange failed" {
		t.Fatal(e)
	}
}
func TestStreamingAndCancellation(t *testing.T) {
	l, c := setup(t, nil)
	flushed := make(chan struct{})
	release := make(chan struct{})
	s := httptest.NewServer(l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("first\n"))
		if err := http.NewResponseController(w).Flush(); err != nil {
			panic(err)
		}
		close(flushed)
		<-release
		_, _ = w.Write([]byte("last\n"))
	})))
	defer s.Close()
	response, err := s.Client().Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	<-flushed
	if len(c.events(t)) != 0 {
		t.Fatal("emitted before stream finished")
	}
	close(release)
	p, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(p) != "first\nlast\n" {
		t.Fatal(string(p), err)
	}
	if es := c.events(t); len(es) != 1 || es[0]["status_code"] != float64(200) {
		t.Fatal(es)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("GET", "/cancel", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	l.WideEventMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { cancel() })).ServeHTTP(w, r)
	e := c.events(t)[1]
	if _, ok := e["status_code"]; ok {
		t.Fatal("invented status", e)
	}
	if e["level"] != "error" {
		t.Fatal(e)
	}
}

type bareWriter struct {
	header http.Header
	status int
}

func (w *bareWriter) Header() http.Header         { return w.header }
func (w *bareWriter) WriteHeader(s int)           { w.status = s }
func (w *bareWriter) Write(p []byte) (int, error) { return len(p), nil }
func TestControllerUnsupportedAndHijack(t *testing.T) {
	bare := &bareWriter{header: make(http.Header)}
	w := &responseWriter{ResponseWriter: bare}
	if err := http.NewResponseController(w).Flush(); !errors.Is(err, http.ErrNotSupported) || w.status != 0 {
		t.Fatal(err, w.status)
	}
	if _, _, err := http.NewResponseController(w).Hijack(); !errors.Is(err, http.ErrNotSupported) {
		t.Fatal(err)
	}
	l, c := setup(t, nil)
	s := httptest.NewServer(l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, b, err := http.NewResponseController(w).Hijack()
		if err != nil {
			panic(err)
		}
		defer conn.Close()
		_, _ = b.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
		_ = b.Flush()
	})))
	defer s.Close()
	resp, err := s.Client().Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	// Wait for the handler boundary rather than assume client read implies finalization.
	deadline := time.Now().Add(time.Second)
	for len(c.events(t)) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	es := c.events(t)
	if len(es) != 1 {
		t.Fatal(es)
	}
	if _, ok := es[0]["status_code"]; ok {
		t.Fatal("hijack status is unobserved", es)
	}
}
func TestSamplingMeasurementsAndThreshold(t *testing.T) {
	zero := 0.0
	threshold := 100 * time.Millisecond
	policy := Sampling{Rate: &zero, SlowThreshold: &threshold, SLOFailure: func(e Event, _ Observation) bool { return e["flow"] == "objective_failed" }, Retain: func(e Event) bool { return e["flow"] == "investigate" }}
	cases := []struct {
		e              Event
		recovery, want bool
	}{
		{Event{"level": "info"}, false, false}, {Event{"error": Event{"message": "bad"}}, false, true}, {Event{"status_code": 429}, false, true}, {Event{"level": "warn"}, false, true}, {Event{"flow": "objective_failed"}, false, true}, {Event{"flow": "investigate"}, false, true}, {Event{"level": "info"}, true, true},
	}
	for _, tc := range cases {
		if got := ShouldSample(tc.e, policy, Observation{ConfirmedRecovery: tc.recovery}); got != tc.want {
			t.Fatal(tc, got)
		}
	}
	var measured atomic.Int64
	l, c := setup(t, func(c *Config) { c.Sampling = policy; c.Measure = func(e Event, _ Observation) { measured.Add(1) } })
	for _, duration := range []float64{99.999, 100, 100.001} {
		e := Event{"method": "GET", "status_code": 200, "duration_ms": duration}
		e["level"] = classifyLevel(e, Observation{ResponseCompleted: true}, policy)
		if ShouldSample(e, policy, Observation{}) != (duration >= 100) {
			t.Fatal(e)
		}
	}

	for i := 0; i < 3; i++ {
		l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if i == 1 {
				w.WriteHeader(400)
			}
			if i == 2 {
				EventFrom(r.Context())["flow"] = "objective_failed"
			}
		})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	}
	if measured.Load() != 3 || len(c.events(t)) != 2 {
		t.Fatal(measured.Load(), c.events(t))
	}
	// Zero is an exact, non-flaky threshold for the real completion path.
	slow := time.Duration(0)
	l, c = setup(t, func(c *Config) { c.Sampling.Rate = &zero; c.Sampling.SlowThreshold = &slow })
	l.WideEventMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	if c.events(t)[0]["level"] != "warn" {
		t.Fatal(c.events(t))
	}
}

type customError struct {
	Code    string `json:"code"`
	Details Event  `json:"details"`
}

func (e customError) Error() string { return "provider declined" }
func TestRedactionProjectionsAndResponseUnchanged(t *testing.T) {
	l, c := setup(t, func(c *Config) {
		c.AdditionalRedactions = []string{"internal-note"}
		c.HTTP = HTTPConfig{
			RequestHeaders: []string{"X-Tag", "Authorization"}, ResponseHeaders: []string{"Location", "Set-Cookie", "X-Tag"},
			Path: func(*http.Request) string { return "/orders/:id" }, Metadata: func(r *http.Request) Event {
				return Event{"route": "GET /orders/{id}", "params": Event{"id": "approved"}, "query": QueryValues(r.URL.Query(), "tag", "access_token")}
			},
			RequestBody: func(r *http.Request, e Event) (any, bool) {
				return Event{"PASSWORD": "SECRET", "email": "a@example.com", "nested": []any{Event{"refresh.Token": "SECRET", "internal_note": "SECRET"}}}, true
			},
			ResponseBody: func(r *http.Request, e Event) (any, bool) { return Event{"result": "ok"}, true },
		}
	})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/orders/SECRET?tag=a&tag=b&access_token=SECRET", nil)
	r.Header.Add("X-Tag", "a")
	r.Header.Add("X-Tag", "b")
	r.Header.Set("Authorization", "SECRET")
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e := EventFrom(r.Context())
		e["error"] = customError{Code: "DECLINED", Details: Event{"Api-Key": "SECRET", "retryable": true}}
		e["encoded"] = `{"password":"SECRET","ok":true}`
		e["user"] = Event{"email": "a@example.com", "phone": "123"}
		w.Header().Set("Set-Cookie", "SECRET")
		w.Header().Set("Location", "https://name:SECRET@example.com/orders?token=SECRET#SECRET")
		_, _ = w.Write([]byte("SECRET actual response"))
	})).ServeHTTP(w, r)
	if w.Body.String() != "SECRET actual response" || w.Header().Get("Set-Cookie") != "SECRET" || r.Header.Get("Authorization") != "SECRET" {
		t.Fatal("mutated application I/O")
	}
	es := c.events(t)
	line := string(c.lines[0])
	if strings.Contains(line, "SECRET") || !strings.Contains(line, redacted) || !strings.Contains(line, "a@example.com") {
		t.Fatal(line)
	}
	e := es[0]
	if encoded, ok := e["encoded"].(string); !ok || !strings.Contains(encoded, redacted) {
		t.Fatal("encoded JSON must remain a sanitized string")
	}
	req := e["request"].(map[string]any)
	if len(req["query"].(map[string]any)["tag"].([]any)) != 2 || len(req["headers"].(map[string]any)["x-tag"].([]any)) != 2 {
		t.Fatal(req)
	}
	if e["error"].(map[string]any)["details"].(map[string]any)["retryable"] != true || e["error"].(map[string]any)["message"] != "provider declined" {
		t.Fatal(e)
	}
}
func TestBoundedJSONCyclesAndSinkFailures(t *testing.T) {
	for _, limit := range []int{1024, 32768} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			l, c := setup(t, func(c *Config) {
				c.EventBytes = limit
				c.BodyBytes = 128
				c.HTTP.ResponseBody = func(*http.Request, Event) (any, bool) {
					return Event{"token": "SECRET", "text": strings.Repeat("🙂", 8000)}, true
				}
			})
			cycle := Event{}
			cycle["self"] = cycle
			l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				e := EventFrom(r.Context())
				e["flow"] = "create_order"
				e["extra"] = strings.Repeat("字", 30000)
				e["cycle"] = cycle
				e["error"] = Event{"message": "controlled failure", "details": strings.Repeat("X", 40000)}
				w.WriteHeader(422)
			})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
			es := c.events(t)
			if len(es) != 1 {
				t.Fatal(l.Failures(), es)
			}
			if len(c.lines[0]) > limit || es[0]["flow"] != "create_order" || es[0]["error"] == nil {
				t.Fatal(es)
			}
			response := es[0]["response"].(map[string]any)
			if response["body_capture"] != "truncated" {
				t.Fatal(response)
			}
			if body, ok := response["body"]; ok && size(body) > 128 {
				t.Fatal(body)
			}
		})
	}
	for _, panicSink := range []bool{false, true} {
		l, _ := setup(t, func(c *Config) {
			c.Sink = func([]byte) error {
				if panicSink {
					panic("sink unavailable")
				}
				return errors.New("sink unavailable")
			}
		})
		w := httptest.NewRecorder()
		l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(201) })).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
		if w.Code != 201 || l.Failures() != 1 {
			t.Fatal(w.Code, l.Failures())
		}
	}
	l, c := setup(t, func(c *Config) { c.EventBytes = 1 })
	l.WideEventMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	if len(c.events(t)) != 0 || l.Failures() != 1 {
		t.Fatal("unsafe oversize fallback")
	}
}
func TestWorkersNativeFactsAndRecovery(t *testing.T) {
	zero := 0.0
	var measured int
	l, c := setup(t, func(c *Config) { c.Sampling.Rate = &zero; c.Measure = func(Event, Observation) { measured++ } })
	for _, tc := range []struct {
		id        string
		attempt   any
		recovered bool
		err       error
	}{{"first", "native-one", false, nil}, {"retrying", 7, false, errors.New("timeout")}, {"recovered", 8, true, nil}, {"handler_only", 9, false, nil}} {
		e := Event{"job": Event{"id": tc.id, "attempt": tc.attempt}}
		err := l.RunJob(context.Background(), e, func(ctx context.Context, e Event) error { e["flow"] = "send_receipt"; return tc.err }, func() bool { return tc.recovered })
		if !errors.Is(err, tc.err) {
			t.Fatal(err)
		}
	}
	es := c.events(t)
	if measured != 4 || len(es) != 2 {
		t.Fatal(measured, es)
	}
	if es[0]["level"] != "error" || es[1]["level"] != "info" || es[1]["job"].(map[string]any)["attempt"] != float64(8) {
		t.Fatal(es)
	}
	for _, e := range es {
		for _, k := range []string{"method", "path", "status_code", "request_id", "outcome", "calls"} {
			if _, ok := e[k]; ok {
				t.Fatal("invented field", k, e)
			}
		}
	}
}
func TestWorkerPanicAndRequestedCancellation(t *testing.T) {
	l, c := setup(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := l.RunJob(ctx, Event{"job": Event{"id": "cancel_requested"}}, func(context.Context, Event) error { return nil }, nil); err != nil {
		t.Fatal(err)
	}
	if c.events(t)[0]["level"] != "info" {
		t.Fatal("requested cancellation must not imply confirmed failure")
	}
	func() {
		defer func() {
			if recover() != "boom" {
				t.Fatal("worker panic swallowed")
			}
		}()
		_ = l.RunJob(context.Background(), Event{"job": Event{"id": "panic"}}, func(context.Context, Event) error { panic("boom") }, nil)
	}()
	if es := c.events(t); len(es) != 2 || es[1]["level"] != "error" {
		t.Fatal(es)
	}
}
func TestJSONLineSinkAndConfig(t *testing.T) {
	var b bytes.Buffer
	s := JSONLineSink(&b)
	if err := s([]byte(`{"ok":true}`)); err != nil || b.String() != "{\"ok\":true}\n" {
		t.Fatal(b.String(), err)
	}
	bad := 2.0
	if _, err := New(Config{Service: "s", Env: "e", Sink: s, Sampling: Sampling{Rate: &bad}}); err == nil {
		t.Fatal("invalid rate accepted")
	}
}

// Keep compile-time evidence of the supported response writer/controller boundary.
var _ interface {
	Unwrap() http.ResponseWriter
	FlushError() error
	Hijack() (net.Conn, *bufio.ReadWriter, error)
} = (*responseWriter)(nil)

func TestInformationalStatusHeaderSnapshotAndControllerDeadlines(t *testing.T) {
	l, c := setup(t, func(c *Config) { c.HTTP.ResponseHeaders = []string{"X-Tag", "X-Request-ID"} })
	s := httptest.NewServer(l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		control := http.NewResponseController(w)
		if err := control.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
			panic(err)
		}
		w.WriteHeader(103)
		w.Header().Set("X-Tag", "sent")
		w.Header().Set("X-Request-ID", "forged")
		w.WriteHeader(201)
		w.Header().Set("X-Tag", "not sent")
		_, _ = w.Write([]byte("ok"))
	})))
	defer s.Close()
	resp, err := s.Client().Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	es := c.events(t)
	if len(es) != 1 || es[0]["status_code"] != float64(201) || resp.StatusCode != 201 {
		t.Fatal(es, resp.StatusCode)
	}
	headers := es[0]["response"].(map[string]any)["headers"].(map[string]any)
	if headers["x-tag"] != "sent" || resp.Header.Get("X-Tag") != "sent" || headers["x-request-id"] != es[0]["request_id"] {
		t.Fatal(headers)
	}
}

type unreadBody struct{ reads int }

func (b *unreadBody) Read([]byte) (int, error) { b.reads++; return 0, io.EOF }
func (b *unreadBody) Close() error             { return nil }
func TestDefaultCaptureNeverReadsBodyAndSkipsEnabledStream(t *testing.T) {
	l, c := setup(t, nil)
	body := &unreadBody{}
	r := httptest.NewRequest("POST", "/", nil)
	r.Body = body
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>application body</html>")) })).ServeHTTP(httptest.NewRecorder(), r)
	if body.reads != 0 {
		t.Fatal("logging consumed body")
	}
	e := c.events(t)[0]
	if _, ok := e["response"].(map[string]any)["body"]; ok {
		t.Fatal(e)
	}
	var projected bool
	l, c = setup(t, func(c *Config) {
		c.HTTP.ResponseBody = func(*http.Request, Event) (any, bool) { projected = true; return "should not capture", true }
	})
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("stream"))
		_ = http.NewResponseController(w).Flush()
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	response := c.events(t)[0]["response"].(map[string]any)
	if projected || response["body"] != nil || response["body_capture"] != nil {
		t.Fatal(response)
	}
}
func TestSanitizerPreservesCoreAndBoundsMalformedValues(t *testing.T) {
	l, c := setup(t, func(c *Config) {
		c.AdditionalRedactions = []string{"email"}
		c.HTTP.ResponseBody = func(*http.Request, Event) (any, bool) {
			a := make([]any, 200)
			for i := range a {
				a[i] = Event{"password": "SECRET"}
			}
			return a, true
		}
	})
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e := EventFrom(r.Context())
		for i := 0; i < 1000; i++ {
			e[fmt.Sprintf("field%d", i)] = make([]any, 1000)
		}
		e["flow"] = "large_event"
		e["user"] = Event{"email": "SECRET"}
		e["error"] = errors.New(`{"password":"SECRET","reason":"controlled"}`)
		w.WriteHeader(409)
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	es := c.events(t)
	if len(es) != 1 {
		t.Fatal(l.Failures(), es)
	}
	e := es[0]
	for _, k := range []string{"timestamp", "service", "env", "request_id", "duration_ms", "flow", "status_code", "error"} {
		if e[k] == nil || e[k] == omitted {
			t.Fatal(k, e)
		}
	}
	if strings.Contains(string(c.lines[0]), "SECRET") || e["response"].(map[string]any)["body_capture"] != "truncated" {
		t.Fatal(string(c.lines[0]))
	}
}
func TestCallbacksFailOpenAndLoggingDoesNotBreakResult(t *testing.T) {
	zero := 0.0
	l, c := setup(t, func(c *Config) {
		c.Sampling.Rate = &zero
		c.Measure = func(Event, Observation) { panic("private metric failure") }
		c.Sampling.SLOFailure = func(Event, Observation) bool { panic("private policy failure") }
	})
	w := httptest.NewRecorder()
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(202) })).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 202 || l.Failures() != 2 || len(c.events(t)) != 1 {
		t.Fatal(w.Code, l.Failures(), c.events(t))
	}
	l, c = setup(t, func(c *Config) { c.ScrubText = func(string) string { panic("private scrubber failure") } })
	w = httptest.NewRecorder()
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(202) })).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 202 || l.Failures() == 0 || len(c.events(t)) != 0 {
		t.Fatal(w.Code, l.Failures(), c.events(t))
	}
}
func TestObservationKeepsSLOCompletionTruthful(t *testing.T) {
	zero := 0.0
	l, c := setup(t, func(c *Config) {
		c.Sampling.Rate = &zero
		c.Sampling.SLOFailure = func(e Event, o Observation) bool { return !o.ResponseCompleted }
	})
	// A real protocol upgrade status is not proof of completion, even on return.
	w := httptest.NewRecorder()
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(101) })).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if es := c.events(t); len(es) != 1 || es[0]["status_code"] != float64(101) {
		t.Fatal(es)
	}
}

func TestActualClientCancellationAndWriteError(t *testing.T) {
	c := &capture{}
	done := make(chan struct{})
	l, err := New(Config{Service: "api", Env: "test", Sink: func(p []byte) error { err := c.sink(p); close(done); return err }})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ready\n"))
		_ = http.NewResponseController(w).Flush()
		<-r.Context().Done()
	})))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	resp, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	resp.Body.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not finalize after disconnect")
	}
	es := c.events(t)
	if len(es) != 1 || es[0]["level"] != "error" || es[0]["status_code"] != float64(200) {
		t.Fatal(es)
	}
	l, c = setup(t, nil)
	bad := &failingWriter{bareWriter: bareWriter{header: make(http.Header)}}
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("cannot send")) })).ServeHTTP(bad, httptest.NewRequest("GET", "/", nil))
	if e := c.events(t)[0]; e["level"] != "error" || e["status_code"] != float64(200) {
		t.Fatal(e)
	}
}

type failingWriter struct{ bareWriter }

func (*failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestAdditionalCoreRedactionAndNativeErrorCode(t *testing.T) {
	l, c := setup(t, func(c *Config) { c.AdditionalRedactions = []string{"flow"} })
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e := EventFrom(r.Context())
		e["flow"] = "SECRET"
		e["error"] = customError{Code: "DECLINED", Details: Event{"auth": "SECRET"}}
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	e := c.events(t)[0]
	if e["flow"] != redacted || e["error"].(map[string]any)["code"] != "DECLINED" || strings.Contains(string(c.lines[0]), "SECRET") {
		t.Fatal(e)
	}
}

func TestDefaultBodyBudgetAndSensitiveArrayShape(t *testing.T) {
	l, c := setup(t, func(c *Config) {
		c.HTTP.Metadata = func(r *http.Request) Event {
			return Event{"query": QueryValues(r.URL.Query(), "access_token", "state")}
		}
		c.HTTP.ResponseBody = func(*http.Request, Event) (any, bool) {
			return Event{"api_key": "SECRET", "text": strings.Repeat("λ", 10000)}, true
		}
	})
	l.WideEventMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(201) })).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/?access_token=SECRET&access_token=SECRET&state=SECRET&state=SECRET", nil))
	e := c.events(t)[0]
	if len(c.lines[0]) > 32768 {
		t.Fatal("event exceeds default budget")
	}
	response := e["response"].(map[string]any)
	if response["body_capture"] != "truncated" || size(response["body"]) > 8192 || !containsRedaction(response["body"]) {
		t.Fatal(response)
	}
	query := e["request"].(map[string]any)["query"].(map[string]any)
	for _, key := range []string{"access_token", "state"} {
		a := query[key].([]any)
		if len(a) != 2 || a[0] != redacted || a[1] != redacted {
			t.Fatal(query)
		}
	}
	if strings.Contains(string(c.lines[0]), "SECRET") {
		t.Fatal("secret escaped redaction")
	}
}

func TestWorkerHTTPFieldsRemovedAndFlatIdentityRetained(t *testing.T) {
	l, c := setup(t, func(cfg *Config) { cfg.EventBytes = 512 })
	event := Event{"job_id": "native-job", "attempt": "native-attempt", "method": "POST", "status_code": 503}
	err := l.RunJob(context.Background(), event, func(_ context.Context, e Event) error {
		if _, exists := e["method"]; exists {
			t.Fatal("HTTP metadata reached worker")
		}
		e["response"] = Event{"body": "unrelated HTTP response"}
		e["large"] = strings.Repeat("x", 4000)
		e["connection_string"] = "credential-sentinel"
		return nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := c.events(t)[0]
	if got["job_id"] != "native-job" || got["attempt"] != "native-attempt" {
		t.Fatal("native identity lost")
	}
	if got["level"] != "info" {
		t.Fatal("HTTP status changed worker level")
	}
	for _, key := range []string{"method", "status_code", "response"} {
		if _, exists := got[key]; exists {
			t.Fatalf("HTTP field survived: %s", key)
		}
	}
	if strings.Contains(string(c.lines[0]), "credential-sentinel") {
		t.Fatal("credential leaked")
	}
}
