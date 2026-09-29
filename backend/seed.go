package main

import (
	"strings"
)

// seedDemo creates a built-in demo scenario the first time the server starts
// against an empty data directory.
func seedDemo(s *Store) {
	s.mu.Lock()
	has := len(s.scenarios) > 0
	s.mu.Unlock()
	if has {
		return
	}
	demo := Scenario{
		Name:        "订单创建/查询（演示）",
		Description: "第一次支付失败、第二次成功；创建订单时写入 orderId，查询时引用它。",
		Enabled:     false,
		InitialState: map[string]interface{}{
			"token": "demo-token",
		},
		Endpoints: []Endpoint{
			{
				Name:          "创建订单",
				Method:        "POST",
				Path:          "/orders",
				DefaultStatus: 201,
				DefaultBody:   `{"id":"{{body.id}}","echo":"{{state.token}}"}`,
				Rules: []Rule{
					{
						ID:      "seed-rule-pay-fail",
						Name:    "创建后支付首次失败",
						Enabled: true,
						NthCall: 1,
						DelayMS: 200,
						Status:  503,
						Body:    `{"error":"temporarily unavailable, retry"}`,
						Extract: []Extract{
							{From: "body", Path: "id", Key: "orderId"},
						},
					},
					{
						ID:       "seed-rule-create-ok",
						Name:     "创建成功并记录 orderId",
						Enabled:  true,
						Priority: 0,
						Status:   201,
						Body:     `{"id":"{{body.id}}","status":"created"}`,
						Extract: []Extract{
							{From: "body", Path: "id", Key: "orderId"},
						},
					},
				},
			},
			{
				Name:          "查询订单",
				Method:        "GET",
				Path:          "/orders/:id",
				DefaultStatus: 200,
				DefaultBody:   `{"id":"{{path.id}}","lastCreated":"{{state.orderId ?? 'none'}}"}`,
			},
		},
	}
	demo.ID = "sc-demo"
	for i := range demo.Endpoints {
		if strings.TrimSpace(demo.Endpoints[i].ID) == "" {
			demo.Endpoints[i].ID = newID("ep")
		}
	}
	_, _ = s.upsert(demo)
}
