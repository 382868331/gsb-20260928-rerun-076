package main

import (
	"flag"
	"log"
	"net/http"
	"path/filepath"

	"mockplatform/internal/api"
	"mockplatform/internal/store"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "data", "data directory for scenarios and runtime state")
	staticDir := flag.String("static", "", "directory of built frontend (optional)")
	flag.Parse()

	if abs, err := filepath.Abs(*dataDir); err == nil {
		*dataDir = abs
	}
	st, err := store.New(*dataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}

	mux := api.New(st).Routes()
	if *staticDir != "" {
		mountSPA(mux, *staticDir)
	}

	log.Printf("mock platform listening on %s (data=%s)", *addr, *dataDir)
	srv := &http.Server{Addr: *addr, Handler: withCORS(mux)}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
