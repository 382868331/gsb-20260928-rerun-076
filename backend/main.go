package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	addr := flag.String("addr", ":8787", "listen address")
	dataDir := flag.String("data", "./data", "scenario storage directory")
	flag.Parse()
	store, err := NewStore(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	seedDemo(store)
	s := &Server{store: store}
	log.Printf("mock platform listening on %s, data=%s", *addr, *dataDir)
	log.Fatal(http.ListenAndServe(*addr, s.routes()))
}
