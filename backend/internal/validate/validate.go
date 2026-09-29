// Package validate checks a scenario definition before rules can be enabled.
package validate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"mockplatform/internal/expr"
	"mockplatform/internal/model"
)

var (
	validMethods = map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true, "OPTIONS": true}
	pathSegRe    = regexp.MustCompile(`^[A-Za-z0-9_\-]+$`)
	paramRe      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	validOps     = map[string]bool{"eq": true, "ne": true, "gt": true, "gte": true, "lt": true, "lte": true, "exists": true, "contains": true, "in": true}
)

// Check returns all issues found. Errors block enabling; warnings do not.
func Check(sc *model.Scenario) []model.Issue {
	issues := []model.Issue{}
	add := func(level, code, target, format string, args ...any) {
		issues = append(issues, model.Issue{Level: level, Code: code, Target: target, Message: fmt.Sprintf(format, args...)})
	}

	if strings.TrimSpace(sc.Name) == "" {
		add("error", "NAME_REQUIRED", "", "场景名称不能为空")
	}

	endpoints := map[string]*model.Endpoint{}
	addrSeen := map[string]string{}
	pathParams := map[string][]string{}
	for i := range sc.Endpoints {
		ep := &sc.Endpoints[i]
		if strings.TrimSpace(ep.ID) == "" {
			add("error", "ENDPOINT_ID", "", "第 %d 个接口缺少 ID", i+1)
			continue
		}
		if _, dup := endpoints[ep.ID]; dup {
			add("error", "ENDPOINT_DUP_ID", ep.ID, "接口 ID 重复: %s", ep.ID)
		}
		endpoints[ep.ID] = ep
		ep.Method = strings.ToUpper(strings.TrimSpace(ep.Method))
		if !validMethods[ep.Method] {
			add("error", "METHOD_INVALID", ep.ID, "接口 %s 的方法 %q 无效", ep.Name, ep.Method)
		}
		params := []string{}
		if !strings.HasPrefix(ep.Path, "/") || strings.ContainsAny(ep.Path, " ") {
			add("error", "PATH_INVALID", ep.ID, "接口 %s 的路径 %q 必须以 / 开头且不含空格", ep.Name, ep.Path)
		} else {
			for _, seg := range strings.Split(strings.Trim(ep.Path, "/"), "/") {
				if seg == "" {
					add("error", "PATH_INVALID", ep.ID, "接口 %s 的路径含空段", ep.Name)
					continue
				}
				if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
					name := seg[1 : len(seg)-1]
					if !paramRe.MatchString(name) {
						add("error", "PARAM_INVALID", ep.ID, "接口 %s 的路径参数 %q 命名非法", ep.Name, seg)
					} else {
						params = append(params, name)
					}
				} else if !pathSegRe.MatchString(seg) {
					add("error", "PATH_INVALID", ep.ID, "接口 %s 的路径段 %q 含非法字符", ep.Name, seg)
				}
			}
		}
		pathParams[ep.ID] = params
		if ep.Method != "" && ep.Path != "" {
			key := ep.Method + " " + ep.Path
			if first, ok := addrSeen[key]; ok {
				add("error", "ENDPOINT_DUP_ADDR", ep.ID, "接口地址 %s 与接口 %s 完全重复", key, first)
			} else {
				addrSeen[key] = ep.ID
			}
		}
	}

	rulesByEndpoint := map[string][]*model.Rule{}
	for i := range sc.Rules {
		r := &sc.Rules[i]
		if strings.TrimSpace(r.ID) == "" {
			add("error", "RULE_ID", "", "第 %d 条规则缺少 ID", i+1)
			continue
		}
		ep, ok := endpoints[r.EndpointID]
		if !ok {
			add("error", "RULE_ENDPOINT_MISSING", r.ID, "规则 %q 绑定的接口不存在", r.Name)
			continue
		}
		if r.Enabled && !ep.Enabled {
			add("error", "RULE_ENDPOINT_DISABLED", r.ID, "规则 %q 已启用，但所属接口 %q 未启用", r.Name, ep.Name)
		}
		rulesByEndpoint[r.EndpointID] = append(rulesByEndpoint[r.EndpointID], r)

		if r.DelayMs < 0 {
			add("error", "DELAY_INVALID", r.ID, "规则 %q 的延迟不能为负", r.Name)
		}
		if r.Response.Status < 100 || r.Response.Status > 599 {
			add("error", "STATUS_INVALID", r.ID, "规则 %q 的响应状态码 %d 非法", r.Name, r.Response.Status)
		}
		if f := r.Failure; f != nil {
			switch f.Type {
			case "http_error":
				if f.Status < 400 || f.Status > 599 {
					add("error", "FAILURE_STATUS", r.ID, "规则 %q 的 http_error 失败状态码必须在 400-599", r.Name)
				}
			case "timeout":
				if f.TimeoutMs <= 0 {
					add("error", "FAILURE_TIMEOUT", r.ID, "规则 %q 的 timeout 必须给出正数 timeoutMs", r.Name)
				}
			case "disconnect":
			default:
				add("error", "FAILURE_TYPE", r.ID, "规则 %q 的失败类型 %q 无效", r.Name, f.Type)
			}
		}
		for ci := range r.Conditions {
			cd := &r.Conditions[ci]
			if !validOps[cd.Op] {
				add("error", "COND_OP", r.ID, "规则 %q 条件操作 %q 无效", r.Name, cd.Op)
			}
			if err := checkExpression(cd.Field); err != nil {
				add("error", "COND_FIELD_EXPR", r.ID, "规则 %q 条件字段表达式错误: %v", r.Name, err)
			}
			if strings.HasPrefix(cd.Field, "path.") {
				param := strings.TrimPrefix(cd.Field, "path.")
				found := false
				for _, p := range pathParams[r.EndpointID] {
					if p == param {
						found = true
					}
				}
				if !found {
					add("warning", "COND_PARAM_ABSENT", r.ID, "规则 %q 引用了接口路径中不存在的参数 %s", r.Name, param)
				}
			}
		}
		for oi := range r.Operations {
			op := &r.Operations[oi]
			if !strings.HasPrefix(op.Target, "state.") {
				add("error", "OP_TARGET", r.ID, "规则 %q 的写入目标必须以 state. 开头", r.Name)
			} else if !paramRe.MatchString(strings.TrimPrefix(op.Target, "state.")) {
				add("error", "OP_TARGET", r.ID, "规则 %q 的状态变量名非法: %s", r.Name, op.Target)
			}
			if op.Op != "set" && op.Op != "increment" && op.Op != "unset" {
				add("error", "OP_KIND", r.ID, "规则 %q 的操作类型 %q 无效 (set/increment/unset)", r.Name, op.Op)
			}
			if op.Op != "unset" {
				if err := checkExpression(op.Value); err != nil {
					add("error", "OP_VALUE_EXPR", r.ID, "规则 %q 操作表达式错误: %v", r.Name, err)
				}
			}
		}
		if strings.Contains(r.Response.Body, "{{") {
			if _, err := expr.Render(r.Response.Body, emptyContext()); err != nil {
				add("error", "BODY_TEMPLATE", r.ID, "规则 %q 响应模板错误: %v", r.Name, err)
			}
		}
		for _, hv := range r.Response.Headers {
			if strings.Contains(hv, "{{") {
				if _, err := expr.Render(hv, emptyContext()); err != nil {
					add("error", "HEADER_TEMPLATE", r.ID, "规则 %q 响应头模板错误: %v", r.Name, err)
				}
			}
		}
		if r.Failure == nil && strings.TrimSpace(r.Response.Body) == "" {
			add("warning", "EMPTY_BODY", r.ID, "规则 %q 的响应体为空", r.Name)
		}
	}

	for _, rules := range rulesByEndpoint {
		enabled := make([]*model.Rule, 0, len(rules))
		for _, r := range rules {
			if r.Enabled {
				enabled = append(enabled, r)
			}
		}
		sort.SliceStable(enabled, func(i, j int) bool { return enabled[i].Priority < enabled[j].Priority })
		seenSigs := map[string]string{}
		priorities := map[int]bool{}
		blockedByUnconditional := false
		for _, r := range enabled {
			if priorities[r.Priority] {
				add("warning", "PRIORITY_DUP", r.ID, "规则 %q 与其他规则优先级相同 (均为 %d)，顺序可能不稳定", r.Name, r.Priority)
			}
			priorities[r.Priority] = true
			if blockedByUnconditional {
				add("error", "RULE_UNREACHABLE", r.ID, "规则 %q 永远不会触发: 更高优先级的无条件规则已拦截所有请求", r.Name)
			}
			if len(r.Conditions) == 0 {
				if len(enabled) > 1 {
					add("error", "RULE_SHADOWS", r.ID, "规则 %q 是无条件规则，会使同接口其他已启用规则失效", r.Name)
				}
				blockedByUnconditional = true
			}
			sig := conditionSignature(r)
			if sig != "" {
				if first, ok := seenSigs[sig]; ok {
					add("error", "RULE_DUPLICATE_CONDITIONS", r.ID, "规则 %q 与规则 %q 的条件完全相同，后者永远不会触发", r.Name, first)
				} else {
					seenSigs[sig] = r.Name
				}
			}
		}
	}

	for i := range sc.Rules {
		r := &sc.Rules[i]
		if strings.TrimSpace(r.Response.Body) != "" && looksLikeJSON(r.Response.Body) {
			var v any
			if err := json.Unmarshal([]byte(r.Response.Body), &v); err != nil {
				add("warning", "BODY_JSON", r.ID, "规则 %q 的响应体看起来是 JSON 但解析失败: %v", r.Name, err)
			}
		}
	}

	return issues
}

func checkExpression(source string) error {
	_, err := expr.Eval(source, emptyContext())
	return err
}

func emptyContext() *expr.Context {
	return &expr.Context{
		Body:    map[string]any{},
		Query:   map[string]any{},
		Headers: map[string]any{},
		Path:    map[string]any{},
		State:   map[string]any{},
	}
}

func conditionSignature(r *model.Rule) string {
	if len(r.Conditions) == 0 {
		return ""
	}
	parts := make([]string, 0, len(r.Conditions))
	for _, c := range r.Conditions {
		raw, _ := json.Marshal(c.Value)
		parts = append(parts, c.Field+"|"+c.Op+"|"+string(raw))
	}
	sort.Strings(parts)
	return strings.Join(parts, ";;")
}

func looksLikeJSON(s string) bool {
	t := strings.TrimSpace(s)
	return strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[")
}

func HasErrors(issues []model.Issue) bool {
	for _, is := range issues {
		if is.Level == "error" {
			return true
		}
	}
	return false
}
