package logging

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"time"
)

type HTTPConfig struct {
	TrustRequestID                  bool
	RequestHeaders, ResponseHeaders []string
	// Path returns an approved path (without query/fragment), or empty to omit.
	Path func(*http.Request) string
	// Metadata returns only explicitly approved route/query/params. No automatic query copying.
	Metadata func(*http.Request) Event
	// Body capture never reads streams: these callbacks observe already-parsed,
	// approved projections at handler completion. Nil means disabled.
	RequestBody, ResponseBody func(*http.Request, Event) (any, bool)
}

type eventKey struct{}

func EventFrom(ctx context.Context) Event { e, _ := ctx.Value(eventKey{}).(map[string]any); return e }

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func (l *Logger) WideEventMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		e := l.event()
		cfg := l.config.HTTP
		id := ""
		if cfg.TrustRequestID && len(r.Header.Values("X-Request-ID")) == 1 {
			candidate := r.Header.Get("X-Request-ID")
			if requestIDPattern.MatchString(candidate) {
				id = candidate
			}
		}
		if id == "" {
			var b [16]byte
			if _, err := rand.Read(b[:]); err != nil {
				panic("request ID generation unavailable")
			}
			id = hex.EncodeToString(b[:])
		}
		e["request_id"], e["method"] = id, r.Method
		path := r.URL.EscapedPath()
		l.guarded(func() {
			if cfg.Path != nil {
				path = ""
				path = cfg.Path(r)
			}
		})
		if path != "" {
			e["path"] = strings.SplitN(strings.SplitN(path, "?", 2)[0], "#", 2)[0]
		}
		req := Event{"headers": l.headers(r.Header, cfg.RequestHeaders)}
		if cfg.RequestBody == nil {
			req["body_capture"] = "disabled"
		}
		resp := Event{}
		if cfg.ResponseBody == nil {
			resp["body_capture"] = "disabled"
		}
		e["request"], e["response"] = req, resp
		w.Header().Set("X-Request-ID", id)
		rw := &responseWriter{ResponseWriter: w, requestID: id}
		r = r.WithContext(context.WithValue(r.Context(), eventKey{}, e))
		defer func() {
			p := recover()
			abort := false
			if p != nil {
				e["error"] = Event{"name": "panic", "message": "handler panicked"}
				if err, ok := p.(error); ok && err != http.ErrAbortHandler {
					e["error"] = err
				}
				if rw.status == 0 && !rw.hijacked && p != http.ErrAbortHandler && r.Context().Err() == nil {
					http.Error(rw, "Internal Server Error", http.StatusInternalServerError)
				} else {
					abort = true
				}
			}
			if err := r.Context().Err(); err != nil {
				if e["error"] == nil {
					e["error"] = err
				}
			}
			if rw.writeErr != nil && e["error"] == nil {
				e["error"] = rw.writeErr
			}
			// Explicitly commit the server's otherwise implicit empty 200 at this boundary.
			if rw.status == 0 && p == nil && !rw.hijacked && r.Context().Err() == nil {
				rw.WriteHeader(http.StatusOK)
			}
			delete(e, "status_code")
			if rw.status != 0 {
				e["status_code"] = rw.status
			}
			e["request_id"], e["method"] = id, r.Method
			delete(e, "path")
			if path != "" {
				e["path"] = strings.SplitN(strings.SplitN(path, "?", 2)[0], "#", 2)[0]
			}
			completedAt := time.Now()
			// Restore owned groups, even if application code overwrote their top-level keys.
			e["request"], e["response"] = req, resp
			l.guarded(func() {
				if cfg.Metadata != nil {
					m := cfg.Metadata(r)
					for _, k := range []string{"route", "params", "query"} {
						if v, ok := m[k]; ok && v != nil {
							if k != "route" && reflect.ValueOf(v).Kind() == reflect.Map && reflect.ValueOf(v).Len() == 0 {
								continue
							}
							req[k] = v
						}
					}
				}
			})
			resp["headers"] = l.headers(rw.sentHeaders, cfg.ResponseHeaders)
			if cfg.RequestBody != nil {
				l.guarded(func() {
					if body, ok := cfg.RequestBody(r, e); ok {
						req["body"] = body
					}
				})
			}
			if cfg.ResponseBody != nil && !rw.flushed && !rw.hijacked {
				l.guarded(func() {
					if body, ok := cfg.ResponseBody(r, e); ok {
						resp["body"] = body
					}
				})
			}
			completed := p == nil && !rw.hijacked && rw.writeErr == nil && r.Context().Err() == nil && rw.status >= 200
			l.finish(e, start, completedAt, Observation{ResponseCompleted: completed, HandlerReturned: p == nil, Hijacked: rw.hijacked})
			// Preserve net/http's interrupted-response behavior after committed headers.
			if abort {
				panic(http.ErrAbortHandler)
			}
		}()
		next.ServeHTTP(rw, r)
	})
}

func (l *Logger) headers(h http.Header, allow []string) Event {
	out := Event{}
	for _, key := range allow {
		name := strings.ToLower(key)
		if l.sensitive[normalizeKey(name)] || normalizeKey(name) == "code" || normalizeKey(name) == "state" {
			continue
		}
		if values := h.Values(key); len(values) == 1 {
			out[name] = values[0]
		} else if len(values) > 1 {
			out[name] = append([]string(nil), values...)
		}
	}
	return out
}

// QueryValues is for explicitly selected query keys, never the full RawQuery.
func QueryValues(v url.Values, approved ...string) Event {
	out := Event{}
	for _, key := range approved {
		if values := v[key]; len(values) == 1 {
			out[key] = values[0]
			if normalizeKey(key) == "code" || normalizeKey(key) == "state" {
				out[key] = redacted
			}
		} else if len(values) > 1 {
			out[key] = append([]string(nil), values...)
			if normalizeKey(key) == "code" || normalizeKey(key) == "state" {
				out[key] = redactValue(reflect.ValueOf(values))
			}
		}
	}
	return out
}

type responseWriter struct {
	http.ResponseWriter
	status            int
	flushed, hijacked bool
	writeErr          error
	requestID         string
	sentHeaders       http.Header
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *responseWriter) WriteHeader(code int) {
	if w.status != 0 || w.hijacked {
		return
	}
	if w.requestID != "" {
		w.Header().Set("X-Request-ID", w.requestID)
	}
	w.ResponseWriter.WriteHeader(code)
	if code >= 200 || code == http.StatusSwitchingProtocols {
		w.status = code
		w.sentHeaders = w.Header().Clone()
	}
}
func (w *responseWriter) Write(p []byte) (int, error) {
	if w.status == 0 && !w.hijacked {
		if w.requestID != "" {
			w.Header().Set("X-Request-ID", w.requestID)
		}
		w.status = http.StatusOK
		w.sentHeaders = w.Header().Clone()
	}
	n, err := w.ResponseWriter.Write(p)
	if err != nil {
		w.writeErr = err
	}
	return n, err
}
func (w *responseWriter) FlushError() error {
	// Do not invent a 200 on a writer which cannot flush.
	if !supportsFlush(w.ResponseWriter) {
		return http.ErrNotSupported
	}
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	w.flushed = true
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.writeErr = err
	}
	return err
}
func supportsFlush(w http.ResponseWriter) bool {
	for {
		switch x := w.(type) {
		case interface{ FlushError() error }:
			return true
		case http.Flusher:
			return true
		case interface{ Unwrap() http.ResponseWriter }:
			w = x.Unwrap()
		default:
			return false
		}
	}
}
func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, b, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.hijacked = true
	}
	return c, b, err
}
