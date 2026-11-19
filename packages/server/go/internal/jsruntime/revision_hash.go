package jsruntime

import (
	"strconv"

	"github.com/dop251/goja"
)

// installRevisionHash accelerates only the character loop of contentRevision.
// Canonical JSON and revision semantics still belong to the shared runtime.
// Iterate UTF-16 code units (including lone surrogates), exactly like charCodeAt;
// converting to a Go UTF-8 string here would change existing document revisions.
func installRevisionHash(vm *goja.Runtime) {
	hash := func(call goja.FunctionCall) goja.Value {
		text := call.Argument(0).ToString().(goja.String)
		h1, h2 := uint32(0xdeadbeef), uint32(0x41c6ce57)
		for i, n := 0, text.Length(); i < n; i++ {
			ch := uint32(text.CharAt(i))
			h1 = (h1 ^ ch) * 2654435761
			h2 = (h2 ^ ch) * 1597334677
		}
		h1 = (h1^(h1>>16))*2246822507 ^ (h2^(h2>>13))*3266489909
		h2 = (h2^(h2>>16))*2246822507 ^ (h1^(h1>>13))*3266489909
		result := (uint64(h2&2097151) << 32) + uint64(h1)
		return vm.ToValue(strconv.FormatUint(result, 16))
	}
	// This is a host primitive, never a request-supplied callback or cache.
	if err := vm.GlobalObject().DefineDataProperty("__blokCyrb53", vm.ToValue(hash), goja.FLAG_FALSE, goja.FLAG_FALSE, goja.FLAG_FALSE); err != nil {
		panic(err)
	}
}
