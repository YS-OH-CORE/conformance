// Local evidence fixture. MCP behavior is provided by the pinned Go SDK.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type observedWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (w *observedWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *observedWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.body.Write(body)
	return w.ResponseWriter.Write(body)
}

func (w *observedWriter) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func main() {
	name := flag.String("name", "warning_tool", "registered tool name")
	observationsPath := flag.String("observations", "", "write complete HTTP observations as JSONL")
	flag.Parse()
	if *observationsPath == "" {
		log.Fatal("-observations is required")
	}
	observations, err := os.OpenFile(*observationsPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer observations.Close()
	var observationMu sync.Mutex
	encoder := json.NewEncoder(observations)

	server := mcp.NewServer(&mcp.Implementation{Name: "go-warning-evidence", Version: "1.0.0"}, nil)
	// At the pinned SDK revision an invalid name is logged but remains registered.
	// This is an intentional negative application configuration, not wire mutation.
	server.AddTool(&mcp.Tool{
		Name:        *name,
		Description: "Lists one tool for a conformance warning control",
		InputSchema: map[string]any{"type": "object"},
	}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil
	})
	sdkHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return server
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = req.Body.Close()
		req.Body = io.NopCloser(bytes.NewReader(body))
		observed := &observedWriter{ResponseWriter: w}
		sdkHandler.ServeHTTP(observed, req)
		if observed.status == 0 {
			observed.status = http.StatusOK
		}
		observationMu.Lock()
		defer observationMu.Unlock()
		if err := encoder.Encode(map[string]any{
			"method": req.Method, "path": req.URL.Path,
			"requestHeaders": req.Header, "requestBody": string(body),
			"responseStatus": observed.status, "responseHeaders": observed.Header(),
			"responseBody": observed.body.String(),
		}); err != nil {
			log.Printf("observation write failed: %v", err)
		}
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
	}()
	fmt.Printf("{\"url\":\"http://%s/mcp\"}\n", listener.Addr())
	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
