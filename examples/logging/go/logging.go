// Package logging adapts Boris Tane's wideEventMiddleware/shouldSample pattern.
// See https://loggingsucks.com/ and the MIT logging-best-practices skill.
package logging

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

type Event = map[string]any

// Observation describes the locally observed boundary, outside the log schema.
// ResponseCompleted means local synchronous HTTP completion, never client receipt.
// HandlerReturned does not imply broker acknowledgement or final queue success.
type Observation struct {
	ResponseCompleted bool
	HandlerReturned   bool
	Hijacked          bool
	ConfirmedRecovery bool
}

type Sampling struct {
	// Nil means 100%; an explicit pointer to zero means 0%.
	Rate          *float64
	SlowThreshold *time.Duration
	SLOFailure    func(Event, Observation) bool
	Retain        func(Event) bool
}

type Config struct {
	Service, Env string
	Deployment   Event
	Sink         func([]byte) error
	Sampling     Sampling
	// Measure receives every completed, sanitized observation before sampling.
	// Use bounded route/operation labels; apply your own SLO eligibility rules.
	Measure               func(Event, Observation)
	AdditionalRedactions  []string
	ScrubText             func(string) string
	BodyBytes, EventBytes int
	HTTP                  HTTPConfig
}

// Logger is configured once at startup; per-unit state is an ordinary Event.
// Callbacks must be bounded, concurrency safe and must not mutate their events.
type Logger struct {
	config    Config
	sensitive map[string]bool
	sinkMu    sync.Mutex
	failures  atomic.Uint64
}

func New(c Config) (logger *Logger, err error) {
	defer func() {
		if recover() != nil {
			logger = nil
			err = errors.New("logging configuration could not be sanitized")
		}
	}()

	if c.Sink == nil {
		return nil, errors.New("JSON sink required")
	}
	if c.Service == "" || c.Env == "" {
		return nil, errors.New("service and env required")
	}
	if c.Sampling.Rate != nil {
		rate := *c.Sampling.Rate
		if math.IsNaN(rate) || rate < 0 || rate > 1 {
			return nil, errors.New("sample rate must be in [0,1]")
		}
		c.Sampling.Rate = &rate
	}
	if c.Sampling.SlowThreshold != nil {
		slow := *c.Sampling.SlowThreshold
		if slow < 0 {
			return nil, errors.New("slow threshold must be nonnegative")
		}
		c.Sampling.SlowThreshold = &slow
	}
	if c.BodyBytes == 0 {
		c.BodyBytes = 8192
	}
	if c.EventBytes == 0 {
		c.EventBytes = 32768
	}
	if c.BodyBytes < 1 || c.EventBytes < 1 {
		return nil, errors.New("byte limits must be positive")
	}
	l := &Logger{config: c, sensitive: make(map[string]bool)}
	for _, key := range append([]string{"auth", "authentication", "authorization", "proxyauthorization", "cookie", "setcookie", "password", "passwd", "pwd", "token", "accesstoken", "refreshtoken", "idtoken", "apikey", "xapikey", "secret", "clientsecret", "credential", "credentials", "privatekey", "secretkey", "bearertoken", "sessiontoken", "sessionid", "xauthtoken", "csrftoken", "xcsrftoken", "newpassword", "oldpassword", "passwordconfirmation", "oauthcode", "oauthstate", "connectionstring", "paymentcredentials", "paymenttoken", "cardnumber", "cvv", "cvc"}, c.AdditionalRedactions...) {
		l.sensitive[normalizeKey(key)] = true
	}
	l.config.HTTP.RequestHeaders = append([]string(nil), c.HTTP.RequestHeaders...)
	l.config.HTTP.ResponseHeaders = append([]string(nil), c.HTTP.ResponseHeaders...)
	// Freeze deployment metadata, including nested containers.
	if c.Deployment == nil {
		c.Deployment = Event{}
	}
	l.config.Deployment = l.sanitize(c.Deployment).(map[string]any)
	return l, nil
}

// JSONLineSink adds exactly one newline. Logger serializes concurrent calls.
func JSONLineSink(w io.Writer) func([]byte) error {
	return func(p []byte) error {
		line := append(append([]byte(nil), p...), '\n')
		n, err := w.Write(line)
		if err == nil && n != len(line) {
			err = io.ErrShortWrite
		}
		return err
	}
}

func (l *Logger) Failures() uint64 { return l.failures.Load() }

// ShouldSample is a completion-time decision, never an early emission method.
// ConfirmedRecovery must come from native queue evidence, not attempt arithmetic.
func ShouldSample(e Event, p Sampling, observed Observation) bool {
	if e["error"] != nil || number(e["status_code"]) >= 400 || e["level"] == "warn" || e["level"] == "error" || observed.ConfirmedRecovery {
		return true
	}
	if p.SLOFailure != nil && p.SLOFailure(e, observed) {
		return true
	}
	if p.Retain != nil && p.Retain(e) {
		return true
	}
	if p.Rate == nil {
		return true
	}
	return rand.Float64() < *p.Rate
}

func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case json.Number:
		n, _ := x.Float64()
		return n
	}
	return 0
}

func (l *Logger) guarded(fn func()) {
	defer func() {
		if recover() != nil {
			l.failures.Add(1)
		}
	}()
	fn()
}

func (l *Logger) finish(e Event, start, completedAt time.Time, observed Observation) {
	// Only this deferred completion path emits; no second terminal hook exists.
	l.guarded(func() {
		e["timestamp"] = completedAt.UTC().Format(time.RFC3339Nano)
		e["duration_ms"] = float64(completedAt.Sub(start)) / float64(time.Millisecond)
		e["service"], e["env"] = l.config.Service, l.config.Env
		if e["error"] == nil {
			delete(e, "error")
		}
		safe := l.sanitize(e).(map[string]any)
		safe["level"] = classifyLevel(safe, observed, l.config.Sampling)
		if l.config.Measure != nil {
			l.guarded(func() { l.config.Measure(safe, observed) })
		}
		keep := true // Callback failure retains diagnostics, without affecting the unit.
		l.guarded(func() { keep = ShouldSample(safe, l.config.Sampling, observed) })
		if !keep {
			return
		}
		line, err := l.bound(safe)
		if err != nil {
			l.failures.Add(1)
			return
		}
		l.sinkMu.Lock()
		defer l.sinkMu.Unlock()
		if err := l.config.Sink(line); err != nil {
			l.failures.Add(1)
		}
	})
}

func (l *Logger) event() Event {
	e := make(Event, len(l.config.Deployment))
	// Per-unit copies prevent concurrent enrichment of shared deployment maps.
	for k, v := range cloneValue(l.config.Deployment).(map[string]any) {
		e[k] = v
	}
	return e
}

func successful(e Event, observed Observation) bool {
	if e["error"] != nil {
		return false
	}
	if _, http := e["method"]; http {
		return observed.ResponseCompleted && number(e["status_code"]) >= 200 && number(e["status_code"]) < 400
	}
	return observed.HandlerReturned
}

func classifyLevel(e Event, observed Observation, p Sampling) string {
	if e["error"] != nil || number(e["status_code"]) >= 400 {
		return "error"
	}
	if successful(e, observed) && p.SlowThreshold != nil && number(e["duration_ms"]) >= float64(*p.SlowThreshold)/float64(time.Millisecond) {
		return "warn"
	}
	return "info"
}

// Deployment is already sanitized; copying it must not invoke application callbacks.
func cloneValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := Event{}
		for k, v := range x {
			out[k] = cloneValue(v)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = cloneValue(v)
		}
		return out
	}
	return v
}
