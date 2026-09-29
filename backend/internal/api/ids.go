package api

import (
	"crypto/rand"
	"encoding/hex"

	"mockplatform/internal/model"
)

func newID(prefix string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

// ensureIDs fills missing client-generated ids so saved definitions stay editable.
func ensureIDs(sc *model.Scenario) {
	for i := range sc.Endpoints {
		if sc.Endpoints[i].ID == "" {
			sc.Endpoints[i].ID = newID("ep")
		}
	}
	for i := range sc.Rules {
		if sc.Rules[i].ID == "" {
			sc.Rules[i].ID = newID("rl")
		}
	}
}
