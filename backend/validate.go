package main

import (
	"fmt"
	"regexp"
	"strings"
)

var validPathSeg = regexp.MustCompile(`^[A-Za-z0-9_.-]+|:[A-Za-z_][A-Za-z0-9_]*$`)

func validateScenario(sc *Scenario) []ValidationIssue {
	var issues []ValidationIssue
	add := func(level, code, msg, ep, rule string) {
		issues = append(issues, ValidationIssue{Level: level, Code: code, Message: msg, Endpoint: ep, Rule: rule})
	}

	knownStates := map[string]bool{}
	for k := range sc.InitialState {
		knownStates[k] = true
	}
	// all extracted keys are potentially produced (ordering across endpoints
	// cannot be guaranteed, so treat them as known and warn per-rule below)
	produced := map[string]bool{}
	type routeKey struct{ m, p string }
	routes := map[routeKey]string{}

	for ei := range sc.Endpoints {
		ep := &sc.Endpoints[ei]
		upperM := strings.ToUpper(ep.Method)
		if upperM == "" {
			add("error", "endpoint.method", "端点缺少 HTTP 方法", ep.ID, "")
		}
		if !strings.HasPrefix(ep.Path, "/") {
			add("error", "endpoint.path", "路径必须以 / 开头", ep.ID, "")
		} else {
			for _, seg := range strings.Split(strings.Trim(ep.Path, "/"), "/") {
				if !validPathSeg.MatchString(seg) {
					add("error", "endpoint.path", fmt.Sprintf("路径段 %q 非法", seg), ep.ID, "")
				}
			}
		}
		rk := routeKey{upperM, ep.Path}
		if other, ok := routes[rk]; ok {
			add("error", "endpoint.duplicate", fmt.Sprintf("与端点 %q 的方法+路径重复", other), ep.ID, "")
		} else {
			routes[rk] = ep.Name
		}
		if ep.DefaultStatus != 0 && (ep.DefaultStatus < 100 || ep.DefaultStatus > 599) {
			add("error", "endpoint.status", "默认状态码必须在 100-599", ep.ID, "")
		}

		ids := map[string]bool{}
		for ri := range ep.Rules {
			r := &ep.Rules[ri]
			if r.ID == "" || ids[r.ID] {
				add("error", "rule.id", "规则 ID 为空或重复", ep.ID, r.ID)
			}
			ids[r.ID] = true
			if r.Fail == nil && (r.Status < 100 || r.Status > 599) {
				add("error", "rule.status", fmt.Sprintf("规则 %q 状态码非法 (%d)", r.Name, r.Status), ep.ID, r.ID)
			}
			if r.DelayMS < 0 || r.DelayMS > 60000 {
				add("error", "rule.delay", fmt.Sprintf("规则 %q 延迟必须在 0-60000ms", r.Name), ep.ID, r.ID)
			}
			if r.Fail != nil && r.Fail.Kind != "reset" && r.Fail.Kind != "timeout" {
				add("error", "rule.fail", fmt.Sprintf("规则 %q 的失败类型非法", r.Name), ep.ID, r.ID)
			}
			if r.NthCall < 0 {
				add("error", "rule.nth", fmt.Sprintf("规则 %q 的重复次数非法", r.Name), ep.ID, r.ID)
			}
			if r.Condition != nil {
				for _, bm := range r.Condition.Body {
					if bm.Op != "eq" && bm.Op != "ne" && bm.Op != "exists" {
						add("error", "rule.condition", fmt.Sprintf("规则 %q 条件操作符 %q 非法", r.Name, bm.Op), ep.ID, r.ID)
					}
				}
			}
			for _, ex := range r.Extract {
				if ex.Key == "" {
					add("error", "rule.extract", fmt.Sprintf("规则 %q 存在未命名的状态写入", r.Name), ep.ID, r.ID)
				}
				produced[ex.Key] = true
			}
			refs := templateRefs(r.Body)
			for _, ref := range refs {
				if strings.HasPrefix(ref, "state.") {
					k := strings.TrimPrefix(ref, "state.")
					if !knownStates[k] && !produced[k] {
						add("warning", "rule.state", fmt.Sprintf("规则 %q 引用了从未初始化或提取的状态 %q", r.Name, k), ep.ID, r.ID)
					}
				}
			}
		}

		// Rule overlap analysis within an endpoint.
		for i := 0; i < len(ep.Rules); i++ {
			a := &ep.Rules[i]
			if !a.Enabled {
				continue
			}
			for j := i + 1; j < len(ep.Rules); j++ {
				b := &ep.Rules[j]
				if !b.Enabled {
					continue
				}
				rel := nthRelation(a.NthCall, b.NthCall)
				if rel == nthDisjoint {
					continue
				}
				cover := conditionRelation(a.Condition, b.Condition)
				if cover == condDisjoint {
					continue
				}
				// an exact nth-call rule deterministically beats a catch-all on
				// that specific call number regardless of configured priority
				exactNth := (a.NthCall > 0 && b.NthCall == 0) || (b.NthCall > 0 && a.NthCall == 0)
				if exactNth {
					continue
				}
				if a.Priority == b.Priority && cover == condEqual {
					add("error", "rule.conflict", fmt.Sprintf("规则 %q 与 %q 条件重叠且优先级相同，结果不确定", a.Name, b.Name), ep.ID, a.ID)
				} else if cover == condPossiblyOverlap {
					add("warning", "rule.conflict", fmt.Sprintf("规则 %q 与 %q 条件可能重叠，当前按优先级 %d 决定", a.Name, b.Name, max(a.Priority, b.Priority)), ep.ID, a.ID)
				}
			}
		}
	}
	return issues
}

type nthRel int

const (
	nthDisjoint nthRel = iota
	nthOverlap
)

func nthRelation(a, b int) nthRel {
	if a == 0 || b == 0 || a == b {
		return nthOverlap
	}
	return nthDisjoint
}

type condRel int

const (
	condEqual condRel = iota
	condDisjoint
	condPossiblyOverlap
)

func conditionRelation(a, b *Condition) condRel {
	if a == nil && b == nil {
		return condEqual
	}
	if a == nil || b == nil {
		// one rule matches everything: it swallows the other unless the other
		// has higher priority — only a possible overlap
		return condPossiblyOverlap
	}
	// Detect a hard disjoint: same header/query/body key with conflicting eq.
	conflict := false
	comparisons := 0
	for k, va := range a.Headers {
		if vb, ok := lookupCI(b.Headers, k); ok {
			comparisons++
			if va != vb {
				conflict = true
			}
		}
	}
	for k, va := range a.Queries {
		if vb, ok := b.Queries[k]; ok {
			comparisons++
			if va != vb {
				conflict = true
			}
		}
	}
	ab := indexBodyEq(a.Body)
	bb := indexBodyEq(b.Body)
	for p, va := range ab {
		if vb, ok := bb[p]; ok {
			comparisons++
			if va != vb {
				conflict = true
			}
		}
	}
	if conflict {
		return condDisjoint
	}
	if comparisons > 0 && len(a.Headers) == len(b.Headers) && len(a.Queries) == len(b.Queries) && len(a.Body) == len(b.Body) {
		return condEqual
	}
	return condPossiblyOverlap
}

func indexBodyEq(ms []BodyMatcher) map[string]string {
	out := map[string]string{}
	for _, m := range ms {
		if m.Op == "eq" {
			out[m.Path] = fmt.Sprint(m.Value)
		}
	}
	return out
}

var stateRefRe = regexp.MustCompile(`{{\s*state\.([\w.-]+)`)

func templateRefs(tpl string) []string {
	ms := stateRefRe.FindAllStringSubmatch(tpl, -1)
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		out = append(out, "state."+m[1])
	}
	return out
}
