package jsruntime

import (
	"math/rand"
	"testing"

	"github.com/dop251/goja"
)

func TestNativeRevisionHashMatchesPortableUTF16(t *testing.T) {
	vm := newVM()
	native, ok := goja.AssertFunction(vm.Get("__blokCyrb53"))
	if !ok {
		t.Fatal("missing native revision hash")
	}
	reference, err := vm.RunString(`(text => {
  let h1=0xdeadbeef,h2=0x41c6ce57;
  for(let i=0;i<text.length;i++) { const ch=text.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677); }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(16);
 })`)
	if err != nil {
		t.Fatal(err)
	}
	portable, _ := goja.AssertFunction(reference)
	cases := [][]uint16{{}, {0}, {'a', 'b', 'c'}, {0xe9, 0xd83c, 0xdfe2}, {0xd800}, {0xdc00}, {0xffff, 0, 0xd800, 0x61, 0xdc00}}
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 100; i++ {
		units := make([]uint16, i*13)
		for j := range units {
			units[j] = uint16(rng.Uint32())
		}
		cases = append(cases, units)
	}
	for i, units := range cases {
		text := goja.StringFromUTF16(units)
		want, err := portable(goja.Undefined(), text)
		if err != nil {
			t.Fatal(err)
		}
		got, err := native(goja.Undefined(), text)
		if err != nil {
			t.Fatal(err)
		}
		if got.String() != want.String() {
			t.Fatalf("case%d got%s want%s", i, got.String(), want.String())
		}
	}
}
