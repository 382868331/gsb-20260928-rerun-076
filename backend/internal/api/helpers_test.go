package api

import (
	"net/http"
	"testing"

	"mockplatform/internal/store"
)

var lastDataDir string

func newTestStore(dir string) (*store.Store, error) {
	lastDataDir = dir
	return store.New(dir)
}

func reopenHandler(t *testing.T, _ http.Handler) http.Handler {
	t.Helper()
	st, err := store.New(lastDataDir)
	if err != nil {
		t.Fatal(err)
	}
	return New(st).Routes()
}
