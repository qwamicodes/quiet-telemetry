package logging

import (
	"context"
	"time"
)

// RunJob is our worker adaptation, not author-provided queue integration.
// Supply an ordinary mutable event with only native job facts. No HTTP identity,
// retry count, state, cancellation or parent link is inferred by this wrapper.
// confirmedRecovery runs after a successful handler and must check confirmed
// broker completion plus native retry history. Nil means unknown/false.
func (l *Logger) RunJob(ctx context.Context, e Event, handler func(context.Context, Event) error, confirmedRecovery func() bool) (err error) {
	start := time.Now()
	if e == nil {
		e = Event{}
	}
	for k, v := range l.event() {
		if _, ok := e[k]; !ok {
			e[k] = v
		}
	}
	for _, key := range []string{"method", "path", "status_code", "request", "response"} {
		delete(e, key)
	}
	defer func() {
		p := recover()
		completedAt := time.Now()
		for _, key := range []string{"method", "path", "status_code", "request", "response"} {
			delete(e, key)
		}
		if err != nil {
			e["error"] = err
		}
		if p != nil {
			e["error"] = Event{"name": "panic", "message": "job handler panicked"}
			if native, ok := p.(error); ok {
				e["error"] = native
			}
		}
		success := p == nil && err == nil && e["error"] == nil
		recovered := false
		if success && confirmedRecovery != nil {
			l.guarded(func() { recovered = confirmedRecovery() })
		}
		l.finish(e, start, completedAt, Observation{HandlerReturned: p == nil, ConfirmedRecovery: recovered})
		// Let the native worker decide retry/ack behavior, including panic recovery.
		if p != nil {
			panic(p)
		}
	}()
	return handler(ctx, e)
}
