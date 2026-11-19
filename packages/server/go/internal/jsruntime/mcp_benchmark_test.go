package jsruntime

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/dop251/goja"
)

// Exercises the embedded interpreter, not Node's JIT. Data is synthetic.
func BenchmarkMCPDocumentRuntime(b *testing.B) {
	for _, size := range []int{100, 627, 5000} {
		blocks := make([]any, size)
		for i := range blocks {
			blocks[i] = map[string]any{"id": fmt.Sprintf("p%d", i), "type": "paragraph", "data": map[string]any{"text": []any{map[string]any{"text": strings.Repeat("Synthetic content for a performance fixture. ", 10)}}}}
		}
		for _, op := range []string{"mcpRead", "agentExecute"} {
			for _, mode := range []string{"portable", "native"} {
				b.Run(fmt.Sprintf("%s/%d/%s", op, size, mode), func(b *testing.B) {
					r, err := benchmarkRuntime(mode)
					if err != nil {
						b.Fatal(err)
					}
					input := map[string]any{"document": map[string]any{"blocks": blocks}, "actor": map[string]any{"id": "benchmark", "name": "Benchmark", "kind": "agent"}, "mcp": map[string]any{"mode": "live", "write": true, "sync": true}, "view": map[string]any{"limit": 1}, "batch": map[string]any{"commands": []any{map[string]any{"name": "block.update", "args": map[string]any{"id": "p0", "data": map[string]any{"text": "Updated"}}}}}}
					raw, err := json.Marshal(input)
					if err != nil {
						b.Fatal(err)
					}
					// Warm the configuration cache independently of the measured document call.
					if _, err = r.Invoke(op, string(raw)); err != nil {
						b.Fatal(err)
					}
					if path := os.Getenv("BLOK_RUNTIME_PROFILE"); path != "" {
						f, err := os.Create(fmt.Sprintf("%s-%s-%d-%s.pprof", path, op, size, mode))
						if err != nil {
							b.Fatal(err)
						}
						defer f.Close()
						if err = goja.StartProfile(f); err != nil {
							b.Fatal(err)
						}
						defer goja.StopProfile()
					}
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						output, err := r.Invoke(op, string(raw))
						if err != nil {
							b.Fatal(err)
						}
						if strings.Contains(output, `"ok":false`) || strings.Contains(output, `"isError":true`) {
							b.Fatalf("Refused: %.500s", output)
						}
					}
				})
			}
		}
	}
}

// Compare both implementations with the same bundle and document. The portable
// VM intentionally omits the optional host primitive; all other setup matches.
func benchmarkRuntime(mode string) (*Runtime, error) {
	if mode == "native" {
		return New()
	}
	program, err := compiled()
	if err != nil {
		return nil, err
	}
	vm := goja.New()
	vm.SetMaxCallStackSize(MaxCallStackSize)
	installLocaleCompare(vm)
	installJSONParseDepth(vm)
	return fromVM(vm, program)
}
