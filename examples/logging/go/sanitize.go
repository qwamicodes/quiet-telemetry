package logging

import (
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const redacted = "[REDACTED]"
const omitted = "[OMITTED]"

func normalizeKey(s string) string {
	return strings.Map(func(r rune) rune {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, s)
}

// Reflection deliberately never invokes arbitrary MarshalJSON/String methods.
// Unsupported values are omitted; traversal caps bound cycles and expansion.
func (l *Logger) sanitize(value any) any {
	remaining := 4096
	truncated := 0
	var walk func(reflect.Value, int) any
	walk = func(v reflect.Value, depth int) any {
		remaining--
		if remaining < 0 || depth > 16 {
			truncated++
			return omitted
		}
		if !v.IsValid() {
			return nil
		}
		if v.Kind() == reflect.Interface {
			if v.IsNil() {
				return nil
			}
			return walk(v.Elem(), depth+1)
		}
		if v.Kind() == reflect.Pointer && v.IsNil() {
			return nil
		}
		// Extract Error() plus exported custom fields, without using error repr as fallback.
		if v.CanInterface() {
			if n, ok := v.Interface().(json.Number); ok {
				f, err := n.Float64()
				if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
					return omitted
				}
				return n
			}
			if err, ok := v.Interface().(error); ok {
				out := Event{}
				if l.sensitive["message"] {
					out["message"] = redacted
				} else {
					out["message"] = walk(reflect.ValueOf(err.Error()), depth+1)
				}
				fields := v
				if fields.Kind() == reflect.Pointer {
					fields = fields.Elem()
				}
				if fields.Kind() == reflect.Struct {
					for i := 0; i < fields.NumField() && i < 128; i++ {
						sf := fields.Type().Field(i)
						if sf.PkgPath != "" {
							continue
						}
						key := fieldName(sf)
						if key == "-" {
							continue
						}
						if l.sensitive[normalizeKey(key)] {
							out[key] = redacted
						} else {
							out[key] = walk(fields.Field(i), depth+1)
						}
					}
				}
				return out
			}
		}
		switch v.Kind() {
		case reflect.Pointer:
			return walk(v.Elem(), depth+1)
		case reflect.String:
			s := v.String()
			if s == redacted || s == omitted {
				return s
			}
			if len(s) > 65536 {
				truncated++
				return omitted
			}
			s = strings.ToValidUTF8(s, "�")
			trimmed := strings.TrimSpace(s)
			if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
				if len(s) > 8192 {
					truncated++
					return omitted
				}
				var parsed any
				if json.Unmarshal([]byte(s), &parsed) != nil {
					truncated++
					return omitted
				}
				safe := walk(reflect.ValueOf(parsed), depth+1)
				encoded, err := json.Marshal(safe)
				if err != nil {
					return omitted
				}
				return string(encoded) // Preserve the caller's string field type.
			}
			return l.text(s)
		case reflect.Bool:
			return v.Bool()
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return v.Int()
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return v.Uint()
		case reflect.Float32, reflect.Float64:
			n := v.Float()
			if math.IsNaN(n) || math.IsInf(n, 0) {
				return nil
			}
			return n
		case reflect.Map:
			if v.IsNil() {
				return nil
			}
			if v.Type().Key().Kind() != reflect.String {
				return omitted
			}
			out := Event{}
			bodyShortened := false
			// Always traverse contract fields first, even in an oversized business map.
			priority := []string{"timestamp", "level", "service", "env", "request_id", "method", "path", "status_code", "duration_ms", "flow", "error", "job", "job_id", "attempt", "request", "response"}
			if depth != 0 {
				priority = []string{"message", "name", "code"}
			}
			for _, key := range priority {
				if item := v.MapIndex(reflect.ValueOf(key).Convert(v.Type().Key())); item.IsValid() {
					if l.sensitive[normalizeKey(key)] {
						out[key] = redactValue(item)
					} else {
						out[key] = walk(item, depth+1)
					}
				}
			}
			if v.Len() > 128 {
				truncated++
			}
			iter := v.MapRange()
			for n := 0; n < 128 && len(out) < 128 && iter.Next() && remaining > 0; n++ {
				key := iter.Key().String()
				if _, exists := out[key]; exists {
					continue
				}
				if len(key) > 256 || !utf8.ValidString(key) {
					truncated++
					continue
				}
				if l.sensitive[normalizeKey(key)] {
					out[key] = redactValue(iter.Value())
				} else {
					before := truncated
					out[key] = walk(iter.Value(), depth+1)
					if key == "body" && truncated > before {
						bodyShortened = true
					}
				}
			}
			if len(out) < v.Len() {
				truncated++
			}
			if bodyShortened {
				out["body_capture"] = "truncated"
			}
			return out
		case reflect.Slice, reflect.Array:
			if v.Kind() == reflect.Slice && v.IsNil() {
				return nil
			}
			// Byte buffers are files/binary, not approved JSON projections.
			if v.Type().Elem().Kind() == reflect.Uint8 {
				return omitted
			}
			n := v.Len()
			if n > 128 {
				n = 128
				truncated++
			}
			out := make([]any, 0, n)
			for i := 0; i < n && remaining > 0; i++ {
				out = append(out, walk(v.Index(i), depth+1))
			}
			if len(out) < v.Len() {
				truncated++
			}
			return out
		case reflect.Struct:
			out := Event{}
			for i := 0; i < v.NumField() && i < 128 && remaining > 0; i++ {
				sf := v.Type().Field(i)
				if sf.PkgPath != "" {
					continue
				}
				key := fieldName(sf)
				if key == "-" {
					continue
				}
				if l.sensitive[normalizeKey(key)] {
					out[key] = redacted
				} else {
					out[key] = walk(v.Field(i), depth+1)
				}
			}
			return out
		}
		return omitted
	}
	safe := walk(reflect.ValueOf(value), 0)
	if e, ok := safe.(map[string]any); ok {
		if s, ok := e["error"].(string); ok {
			e["error"] = Event{"message": s}
		}
	}
	return safe
}
func fieldName(f reflect.StructField) string {
	if tag := strings.Split(f.Tag.Get("json"), ",")[0]; tag != "" {
		return tag
	}
	return f.Name
}

func (l *Logger) text(s string) string {
	if len(s) > 65536 {
		return omitted
	}
	// URLs get no userinfo, query or fragment. Secret path segments require Path/ScrubText.
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "/") {
		if u, err := url.Parse(s); err == nil {
			u.User = nil
			u.RawQuery = ""
			u.ForceQuery = false
			u.Fragment = ""
			s = u.String()
		} else {
			return omitted
		}
	}
	if l.config.ScrubText != nil {
		s = l.config.ScrubText(s)
	}
	return strings.ToValidUTF8(s, "�")
}

func size(v any) int {
	p, err := json.Marshal(v)
	if err != nil {
		return math.MaxInt
	}
	return len(p)
}

// shorten changes JSON values, never slices serialized bytes. It preserves
// redaction markers even when the surrounding preview can no longer fit.
func shorten(v any) any {
	switch x := v.(type) {
	case string:
		if x == redacted || x == omitted {
			return x
		}
		r := []rune(x)
		if len(r) > 32 {
			return string(r[:len(r)/2]) + "…"
		}
		return omitted
	case map[string]any:
		out := Event{}
		for k, v := range x {
			out[k] = shorten(v)
		}
		if size(out) < size(x) {
			return out
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if x[k] != redacted {
				delete(out, k)
				return out
			}
		}
		return redacted
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = shorten(v)
		}
		if size(out) < size(x) {
			return out
		}
		if len(x) > 1 {
			if containsRedaction(x) {
				return redacted
			}
			return out[:len(out)/2]
		}
	}
	return omitted
}
func containsRedaction(v any) bool {
	switch x := v.(type) {
	case string:
		return x == redacted
	case map[string]any:
		for _, v := range x {
			if containsRedaction(v) {
				return true
			}
		}
	case []any:
		for _, v := range x {
			if containsRedaction(v) {
				return true
			}
		}
	}
	return false
}
func fit(v any, limit int) any {
	for i := 0; i < 64 && size(v) > limit; i++ {
		next := shorten(v)
		if size(next) >= size(v) {
			if containsRedaction(v) {
				return redacted
			}
			return nil
		}
		v = next
	}
	return v
}

func (l *Logger) bound(e Event) ([]byte, error) {
	for _, side := range []string{"request", "response"} {
		if group, ok := e[side].(map[string]any); ok {
			if body, ok := group["body"]; ok && size(body) > l.config.BodyBytes {
				body = fit(body, l.config.BodyBytes)
				group["body_capture"] = "truncated"
				if size(body) <= l.config.BodyBytes {
					group["body"] = body
				} else {
					delete(group, "body")
				}
			}
		}
	}
	if size(e) <= l.config.EventBytes {
		return json.Marshal(e)
	}
	// The event limit wins; shrink previews before other optional context.
	for _, side := range []string{"request", "response"} {
		if group, ok := e[side].(map[string]any); ok {
			if _, ok := group["body"]; ok {
				group["body"] = fit(group["body"], 64)
				group["body_capture"] = "truncated"
				if size(e) <= l.config.EventBytes {
					return json.Marshal(e)
				}
				delete(group, "body")
			}
		}
	}
	core := map[string]bool{"timestamp": true, "level": true, "service": true, "env": true, "request_id": true, "method": true, "path": true, "status_code": true, "duration_ms": true, "flow": true, "error": true, "job": true, "job_id": true, "attempt": true}
	keys := make([]string, 0, len(e))
	for k := range e {
		if !core[k] {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return size(e[keys[i]]) > size(e[keys[j]]) })
	for _, k := range keys {
		if k == "request" || k == "response" {
			if g, ok := e[k].(map[string]any); ok {
				delete(g, "headers")
				delete(g, "query")
				delete(g, "params")
				delete(g, "route")
			}
		} else {
			delete(e, k)
		}
		if size(e) <= l.config.EventBytes {
			return json.Marshal(e)
		}
	}
	if err, ok := e["error"].(map[string]any); ok {
		minimal := Event{}
		for _, k := range []string{"message", "name", "code"} {
			if v, ok := err[k]; ok {
				minimal[k] = fit(v, 256)
			}
		}
		e["error"] = minimal
	}
	if size(e) > l.config.EventBytes {
		return nil, errors.New("minimal sanitized event exceeds byte limit")
	}
	return json.Marshal(e)
}

func redactValue(v reflect.Value) any {
	for v.Kind() == reflect.Interface || v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return redacted
		}
		v = v.Elem()
	}
	if v.Kind() == reflect.Array || v.Kind() == reflect.Slice {
		n := v.Len()
		if n > 128 {
			n = 128
		}
		out := make([]any, n)
		for i := range out {
			out[i] = redacted
		}
		return out
	}
	return redacted
}
