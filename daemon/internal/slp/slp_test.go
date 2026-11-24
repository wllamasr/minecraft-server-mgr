package slp

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// serve answers one status request with reply (raw bytes), after checking
// that the request is the one a Minecraft server expects.
func serve(t *testing.T, reply func(host string) []byte) (port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		r := bufio.NewReader(conn)

		n, _ := readVarint(r)
		packet := make([]byte, n)
		if _, err := io.ReadFull(r, packet); err != nil {
			return
		}
		p := bytes.NewReader(packet)
		id, _ := readVarint(p)
		version, _ := readVarint(p)
		hostLen, _ := readVarint(p)
		host := make([]byte, hostLen)
		_, _ = io.ReadFull(p, host)
		var portBytes [2]byte
		_, _ = io.ReadFull(p, portBytes[:])
		next, _ := readVarint(p)
		request := make([]byte, 2)
		if _, err := io.ReadFull(r, request); err != nil {
			return
		}
		if id != 0 || version != -1 || next != 1 || p.Len() != 0 || !bytes.Equal(request, []byte{1, 0}) {
			t.Errorf("unexpected request: id %d version %d next %d rest %d request %v", id, version, next, p.Len(), request)
			return
		}
		_, _ = conn.Write(reply(string(host)))
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func status(json string) []byte {
	var body []byte
	body = append(body, 0x00)
	body = appendVarint(body, int32(len(json)))
	body = append(body, json...)
	return append(appendVarint(nil, int32(len(body))), body...)
}

func TestQuery(t *testing.T) {
	port := serve(t, func(host string) []byte {
		if host != "127.0.0.1" {
			t.Errorf("host in the handshake = %q", host)
		}
		return status(`{"version":{"name":"Paper 1.21.11","protocol":774},"players":{"max":20,"online":3,"sample":[{"name":"Steve","id":"x"}]},"description":"A Minecraft Server","favicon":"data:image/png;base64,` + strings.Repeat("A", 20000) + `"}`)
	})
	got, err := Query("127.0.0.1", port, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got != (Players{Online: 3, Max: 20}) {
		t.Errorf("Query = %+v", got)
	}
}

func TestQueryRejects(t *testing.T) {
	cases := map[string][]byte{
		"no player counts":      status(`{"description":"hi"}`),
		"half the counts":       status(`{"players":{"online":3}}`),
		"negative counts":       status(`{"players":{"online":-1,"max":20}}`),
		"not json":              status(`<html>`),
		"another packet":        append([]byte{3, 0x01, 1}, 'x'),
		"a huge length":         appendVarint(nil, 50_000_000),
		"text longer than said": append(appendVarint(nil, 4), 0x00, 0x7f, 'a', 'b'),
		"nothing":               nil,
	}
	for name, reply := range cases {
		t.Run(name, func(t *testing.T) {
			port := serve(t, func(string) []byte { return reply })
			if got, err := Query("127.0.0.1", port, time.Second); err == nil {
				t.Errorf("accepted: %+v", got)
			}
		})
	}
}

func TestQueryGivesUp(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { // accepts and says nothing
		if conn, err := ln.Accept(); err == nil {
			defer conn.Close()
			time.Sleep(3 * time.Second)
		}
	}()
	start := time.Now()
	if _, err := Query("127.0.0.1", ln.Addr().(*net.TCPAddr).Port, 300*time.Millisecond); err == nil {
		t.Error("no error from a silent server")
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("gave up after %v", took)
	}
}

func TestVarint(t *testing.T) {
	for _, v := range []int32{0, 1, 127, 128, 255, 25565, 2147483647, -1} {
		got, err := readVarint(bytes.NewReader(appendVarint(nil, v)))
		if err != nil || got != int(v) {
			t.Errorf("round trip of %d = %d, %v", v, got, err)
		}
	}
	if _, err := readVarint(bytes.NewReader([]byte{0x80, 0x80, 0x80, 0x80, 0x80, 0x80})); err == nil {
		t.Error("accepted a number of six bytes")
	}
}
