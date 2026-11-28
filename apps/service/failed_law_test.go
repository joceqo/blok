package cloud

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

/*
A 5xx is the server admitting a defect. When one is decided right next to an
error the handler is holding, that error is the only thing that says what
broke: "Read failed" names the shape of the defect, never its cause.

Such a refusal goes through failed(), which keeps it. problem() stays for a
5xx the handler chose with nothing to explain — draining, a protocol answer
it decided on its own.

The rule is mechanical because the hole refills silently: ninety sites dropped
their error for eleven days of production without a single line in the journal.
*/
func TestEveryServerErrorDecidedNextToAnErrorKeepsIt(t *testing.T) {
	sources, e := filepath.Glob("*.go")
	if e != nil {
		t.Fatal(e)
	}
	marks := token.NewFileSet()
	dropped := map[string]bool{}
	for _, path := range sources {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		parsed, e := parser.ParseFile(marks, path, nil, 0)
		if e != nil {
			t.Fatalf("%s: %v", path, e)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			branch, ok := node.(*ast.IfStmt)
			if !ok || !holdsAnError(branch.Cond) {
				return true
			}
			ast.Inspect(branch.Body, func(inner ast.Node) bool {
				if serverRefusal(inner) {
					dropped[marks.Position(inner.Pos()).String()] = true
				}

				return true
			})

			return true
		})
	}
	if len(dropped) == 0 {
		return
	}
	places := make([]string, 0, len(dropped))
	for place := range dropped {
		places = append(places, place)
	}
	sort.Strings(places)
	t.Errorf("%d 5xx refusals drop the error they were handed; call failed() instead of problem():\n%s",
		len(places), strings.Join(places, "\n"))
}

// holdsAnError says whether a condition was reached with an error in hand:
// a nil comparison, or an errors.Is/As that already read one.
func holdsAnError(cond ast.Expr) bool {
	found := false
	ast.Inspect(cond, func(node ast.Node) bool {
		switch test := node.(type) {
		case *ast.BinaryExpr:
			// "not nil" is what proves the branch was taken with an error
			// in hand; an == nil branch is the success path.
			if test.Op != token.NEQ {
				return true
			}
			if name, ok := test.Y.(*ast.Ident); ok && name.Name == "nil" {
				found = true
			}
		case *ast.CallExpr:
			reader, ok := test.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := reader.X.(*ast.Ident)
			if ok && pkg.Name == "errors" && (reader.Sel.Name == "Is" || reader.Sel.Name == "As") {
				found = true
			}
		}

		return !found
	})

	return found
}

// serverRefusal recognises problem(w, 5xx, …): a refusal this server blames
// on itself, written with a status spelled out on the spot.
func serverRefusal(node ast.Node) bool {
	call, ok := node.(*ast.CallExpr)
	if !ok || len(call.Args) < 2 {
		return false
	}
	if name, ok := call.Fun.(*ast.Ident); !ok || name.Name != "problem" {
		return false
	}
	written, ok := call.Args[1].(*ast.BasicLit)
	if !ok || written.Kind != token.INT {
		return false
	}
	status, e := strconv.Atoi(written.Value)

	return e == nil && status >= 500
}
