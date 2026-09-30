package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// resolvePath walks a dot-separated path through decoded JSON values.
// Array segments are integer indexes.
func resolvePath(v interface{}, path string) (interface{}, bool) {
	cur := v
	for _, seg := range strings.Split(path, ".") {
		if seg == "" {
			return nil, false
		}
		switch node := cur.(type) {
		case map[string]interface{}:
			next, ok := node[seg]
			if !ok {
				return nil, false
			}
			cur = next
		case []interface{}:
			i, err := strconv.Atoi(seg)
			if err != nil || i < 0 || i >= len(node) {
				return nil, false
			}
			cur = node[i]
		default:
			return nil, false
		}
	}
	return cur, true
}

func setPath(root map[string]interface{}, path string, value interface{}) bool {
	segs := strings.Split(path, ".")
	cur := root
	for i, seg := range segs {
		if seg == "" {
			return false
		}
		if i == len(segs)-1 {
			cur[seg] = value
			return true
		}
		if i, err := strconv.Atoi(seg); err == nil {
			_ = i
			return false // arrays cannot be created by setPath
		}
		next, ok := cur[seg].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			cur[seg] = next
		}
		cur = next
	}
	return true
}

type renderContext struct {
	state    map[string]interface{}
	body     interface{}
	headers  map[string]string
	queries  map[string]string
	pathVars map[string]string
	callNum  int
}

var tokenRe = regexp.MustCompile("{{\\s*([a-zA-Z]+)\\.([\\w.\\[\\]-]+?)\\s*(?:\\?\\?\\s*(\"[^\"]*\"|'[^']*'))?\\s*}}")

func renderTemplate(tpl string, c renderContext) (string, []string) {
	var missing []string
	out := tokenRe.ReplaceAllStringFunc(tpl, func(m string) string {
		parts := tokenRe.FindStringSubmatch(m)
		source, key, fallback := parts[1], parts[2], parts[3]
		var val interface{}
		var ok bool
		switch source {
		case "state":
			val, ok = resolvePath(c.state, key)
		case "body":
			val, ok = resolvePath(c.body, key)
		case "header":
			val, ok = lookupCI(c.headers, key)
		case "query":
			val, ok = c.queries[key]
		case "path":
			val, ok = c.pathVars[key]
		case "callNumber":
			if key == "" || key == "n" {
				return strconv.Itoa(c.callNum)
			}
			ok = false
		default:
			ok = false
		}
		if !ok {
			if fallback != "" {
				return fallback[1 : len(fallback)-1]
			}
			missing = append(missing, source+"."+key)
			return ""
		}
		return stringifyToken(val)
	})
	return out, missing
}

func stringifyToken(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return "null"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func lookupCI(m map[string]string, key string) (string, bool) {
	if v, ok := m[key]; ok {
		return v, true
	}
	lk := strings.ToLower(key)
	for k, v := range m {
		if strings.ToLower(k) == lk {
			return v, true
		}
	}
	return "", false
}

func conditionMatches(cond *Condition, body interface{}, headers, queries map[string]string) bool {
	if cond == nil {
		return true
	}
	for k, v := range cond.Headers {
		got, ok := lookupCI(headers, k)
		if !ok || got != v {
			return false
		}
	}
	for k, v := range cond.Queries {
		got, ok := queries[k]
		if !ok || got != v {
			return false
		}
	}
	for _, bm := range cond.Body {
		got, ok := resolvePath(body, bm.Path)
		switch bm.Op {
		case "exists":
			if !ok {
				return false
			}
		case "ne":
			if ok && fmt.Sprint(got) == fmt.Sprint(bm.Value) {
				return false
			}
		default: // eq
			if !ok || fmt.Sprint(got) != fmt.Sprint(bm.Value) {
				return false
			}
		}
	}
	return true
}

// matchRoute matches /orders/:id style templates and returns path variables.
func matchRoute(template, actual string) (map[string]string, bool) {
	t := strings.Split(strings.Trim(template, "/"), "/")
	a := strings.Split(strings.Trim(actual, "/"), "/")
	if len(t) != len(a) {
		return nil, false
	}
	vars := map[string]string{}
	for i := range t {
		if strings.HasPrefix(t[i], ":") {
			vars[t[i][1:]] = a[i]
		} else if t[i] != a[i] {
			return nil, false
		}
	}
	return vars, true
}
