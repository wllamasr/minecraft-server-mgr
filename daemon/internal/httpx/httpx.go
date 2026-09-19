// Package httpx provides a small, robust HTTP helper shared by the download
// paths (server jars, JDKs, loaders, modpack files).
//
// It disables HTTP/2 and retries transient failures. Some CDNs intermittently
// abort large downloads over HTTP/2 with "stream ... PROTOCOL_ERROR"; HTTP/1.1
// is markedly more reliable for big file transfers, and a couple of retries
// smooth over brief network blips on remote hosts.
package httpx

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func newClient(timeout time.Duration) *http.Client {
	tr := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		ForceAttemptHTTP2: false,
		// A non-nil, empty TLSNextProto disables HTTP/2 negotiation.
		TLSNextProto:        make(map[string]func(authority string, c *tls.Conn) http.RoundTripper),
		MaxIdleConns:        10,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 20 * time.Second,
	}
	return &http.Client{Timeout: timeout, Transport: tr}
}

func withRetry(attempts int, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = fn(); err == nil {
			return nil
		}
		time.Sleep(time.Duration(i+1) * 2 * time.Second)
	}
	return err
}

// GetJSON fetches url and decodes the JSON body into target.
func GetJSON(url string, target any) error {
	return withRetry(3, func() error {
		resp, err := newClient(60 * time.Second).Get(url)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
		}
		return json.NewDecoder(resp.Body).Decode(target)
	})
}

// GetText fetches url and returns the body as a string.
func GetText(url string) (string, error) {
	var out string
	err := withRetry(3, func() error {
		resp, err := newClient(60 * time.Second).Get(url)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		out = string(b)
		return nil
	})
	return out, err
}

// Download streams url to dest (atomically, via a .part file), with retries.
func Download(url, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o750); err != nil {
		return err
	}
	return withRetry(3, func() error {
		resp, err := newClient(15 * time.Minute).Get(url)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
		}
		tmp := dest + ".part"
		out, err := os.Create(tmp)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, resp.Body); err != nil {
			out.Close()
			os.Remove(tmp)
			return err
		}
		if err := out.Close(); err != nil {
			os.Remove(tmp)
			return err
		}
		return os.Rename(tmp, dest)
	})
}
