// Package slp asks a Minecraft server how many players are on it, the way
// the game's server list does (the "Server List Ping" status request).
package slp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// maxResponse bounds what is read from the server. A status holds the
// server's icon (a PNG of some kilobytes as base64) and whatever a plugin
// put in the description; nothing honest comes near this.
const maxResponse = 256 * 1024

// Players is what a server says about who is on it.
type Players struct {
	Online int `json:"online"`
	Max    int `json:"max"`
}

// Query asks the server at host:port. It gives up after timeout.
func Query(host string, port int, timeout time.Duration) (Players, error) {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), timeout)
	if err != nil {
		return Players{}, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	// Handshake (packet 0x00): protocol version -1 ("just asking"), the
	// address, the port, next state 1 (status). Then the status request.
	var handshake []byte
	handshake = append(handshake, 0x00)
	handshake = appendVarint(handshake, -1)
	handshake = appendVarint(handshake, int32(len(host)))
	handshake = append(handshake, host...)
	handshake = append(handshake, byte(port>>8), byte(port))
	handshake = appendVarint(handshake, 1)

	var out []byte
	out = appendVarint(out, int32(len(handshake)))
	out = append(out, handshake...)
	out = append(out, 0x01, 0x00)
	if _, err := conn.Write(out); err != nil {
		return Players{}, err
	}

	r := bufio.NewReader(conn)
	length, err := readVarint(r)
	if err != nil {
		return Players{}, err
	}
	if length <= 0 || length > maxResponse {
		return Players{}, fmt.Errorf("status response of %d bytes", length)
	}
	body := bufio.NewReader(io.LimitReader(r, int64(length)))
	if id, err := readVarint(body); err != nil || id != 0 {
		return Players{}, errors.New("not a status response")
	}
	size, err := readVarint(body)
	if err != nil {
		return Players{}, err
	}
	if size <= 0 || size > length {
		return Players{}, fmt.Errorf("status text of %d bytes in a response of %d", size, length)
	}
	text := make([]byte, size)
	if _, err := io.ReadFull(body, text); err != nil {
		return Players{}, err
	}

	// Only the two counts are taken; the rest of the document is the
	// server's (and its plugins') to fill as they like.
	var status struct {
		Players *struct {
			Online *int `json:"online"`
			Max    *int `json:"max"`
		} `json:"players"`
	}
	if err := json.Unmarshal(text, &status); err != nil {
		return Players{}, err
	}
	if status.Players == nil || status.Players.Online == nil || status.Players.Max == nil {
		return Players{}, errors.New("the status has no player counts")
	}
	if *status.Players.Online < 0 || *status.Players.Max < 0 {
		return Players{}, errors.New("the status has negative player counts")
	}
	return Players{Online: *status.Players.Online, Max: *status.Players.Max}, nil
}

func appendVarint(b []byte, v int32) []byte {
	u := uint32(v)
	for {
		if u&^0x7f == 0 {
			return append(b, byte(u))
		}
		b = append(b, byte(u&0x7f)|0x80)
		u >>= 7
	}
}

func readVarint(r io.ByteReader) (int, error) {
	var v uint32
	for i := 0; i < 5; i++ {
		c, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		v |= uint32(c&0x7f) << (7 * i)
		if c&0x80 == 0 {
			return int(int32(v)), nil
		}
	}
	return 0, errors.New("number too long")
}
