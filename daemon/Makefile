# msmd — Minecraft Server Manager daemon
#
# Pure Go, no cgo: every target is a single static binary.

BINARY := msmd
PKG    := ./cmd/msmd
DIST   := dist

.PHONY: build run test vet fmt clean cross smoke

build:
	CGO_ENABLED=0 go build -o $(BINARY) $(PKG)

run: build
	./$(BINARY) -data ./msmd-data

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

# Cross-compile release binaries for common host targets.
cross:
	mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -o $(DIST)/$(BINARY)-linux-amd64   $(PKG)
	CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -o $(DIST)/$(BINARY)-linux-arm64   $(PKG)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o $(DIST)/$(BINARY)-windows-amd64.exe $(PKG)

# Full end-to-end smoke test (build + run over TLS + hit the API).
smoke:
	sh scripts/smoke.sh

clean:
	rm -rf $(BINARY) $(DIST) msmd-data
