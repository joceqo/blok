package cloud

import (
	"embed"
	"fmt"
	"html"
	"regexp"
	"strings"
)

// Rendered by scripts/build-email-templates.mjs from the React Email sources
// in emails/. Embedded so a deployed binary carries its own messages.
//
//go:embed templates/*.html templates/*.txt
var mailTemplates embed.FS

var mailMarker = regexp.MustCompile(`\{\{(\w+)\}\}`)

// {{#name}}…{{/name}} wraps a block the services drop when the value is empty.
var mailSection = regexp.MustCompile(`(?s)\{\{#(\w+)\}\}(.*?)\{\{/\w+\}\}`)

// mailTemplate fills one template's text and HTML parts with values. HTML
// values are escaped: a workspace name or address is user input, and an
// unescaped one would inject markup into the message.
func mailTemplate(name string, values map[string]string) (string, string, error) {
	read := func(extension string) (string, error) {
		content, e := mailTemplates.ReadFile("templates/" + name + "." + extension)
		if e != nil {
			return "", fmt.Errorf("unknown mail template %q", name)
		}
		return string(content), nil
	}
	text, e := read("txt")
	if e != nil {
		return "", "", e
	}
	markup, e := read("html")
	if e != nil {
		return "", "", e
	}
	// The plain-text rendering uppercases headings, markers included, so a
	// {{workspace}} inside one arrives as {{WORKSPACE}}: match names loosely.
	lookup := func(name string) string {
		for key, value := range values {
			if strings.EqualFold(key, name) {
				return value
			}
		}
		return ""
	}
	fill := func(template string, escape bool) string {
		template = mailSection.ReplaceAllStringFunc(template, func(section string) string {
			parts := mailSection.FindStringSubmatch(section)
			if lookup(parts[1]) == "" {
				return ""
			}
			return parts[2]
		})
		return mailMarker.ReplaceAllStringFunc(template, func(marker string) string {
			value := lookup(mailMarker.FindStringSubmatch(marker)[1])
			if escape {
				return html.EscapeString(value)
			}
			return value
		})
	}
	return strings.TrimSpace(fill(text, false)), fill(markup, true), nil
}

// sendDeliveryTest sends the "does mail work" probe the admin and setup
// screens offer.
func (s *Service) sendDeliveryTest(email string) error {
	text, markup, e := mailTemplate("delivery-test", map[string]string{"publicURL": s.Config.PublicURL})
	if e != nil {
		return e
	}
	return s.send(email, "Test de livraison Blok", text, markup)
}
