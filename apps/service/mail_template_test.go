package cloud

import (
	"strings"
	"testing"
)

func TestMailTemplateSubstitutesEscapesAndLeavesNoMarker(t *testing.T) {
	text, html, e := mailTemplate("login-code", map[string]string{"code": "123456", "publicURL": "https://blok.test/<a>"})
	if e != nil {
		t.Fatal(e)
	}
	for name, body := range map[string]string{"text": text, "html": html} {
		if !strings.Contains(body, "123456") {
			t.Errorf("%s part lost the code", name)
		}
		if strings.Contains(body, "{{") {
			t.Errorf("%s part still carries a marker", name)
		}
	}
	// A value reaching the HTML part unescaped would let a crafted workspace
	// name inject markup into the message.
	if !strings.Contains(html, "&lt;a&gt;") || strings.Contains(html, "/<a>") {
		t.Errorf("html part did not escape the value: %q", html)
	}
	if !strings.Contains(text, "/<a>") {
		t.Errorf("text part should keep the raw value: %q", text)
	}
}

func TestMailTemplateRejectsUnknownName(t *testing.T) {
	if _, _, e := mailTemplate("does-not-exist", nil); e == nil {
		t.Fatal("expected an error for an unknown template")
	}
}

func TestMailTemplateDropsAnEmptyOptionalSection(t *testing.T) {
	with, withHTML, e := mailTemplate("invitation", map[string]string{"workspace": "Acme", "publicURL": "https://blok.test", "message": "À bientôt"})
	if e != nil {
		t.Fatal(e)
	}
	for name, body := range map[string]string{"text": with, "html": withHTML} {
		if !strings.Contains(body, "À bientôt") || !strings.Contains(body, "Message de l") {
			t.Errorf("%s part lost the administrator note", name)
		}
	}
	without, withoutHTML, e := mailTemplate("invitation", map[string]string{"workspace": "Acme", "publicURL": "https://blok.test"})
	if e != nil {
		t.Fatal(e)
	}
	// Without a note the whole block goes, heading included: a lone
	// "Message de l'administrateur" above nothing reads as a broken mail.
	for name, body := range map[string]string{"text": without, "html": withoutHTML} {
		if strings.Contains(body, "Message de l") {
			t.Errorf("%s part kept the note heading with no note", name)
		}
		if strings.Contains(body, "{{") || strings.Contains(body, "}}") {
			t.Errorf("%s part still carries a marker", name)
		}
		if !strings.Contains(body, "Acme") {
			t.Errorf("%s part lost the workspace name", name)
		}
	}
}
