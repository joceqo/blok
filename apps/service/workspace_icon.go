package cloud

import (
	"encoding/base64"
	"strings"
	"unicode"
)

// validWorkspaceIcon reprend les formes acceptees par le validateur Node
// (teamspace-directory.ts) : rien, une icone nommee, un PNG encode sur place,
// ou un emoji. Jamais une URL distante, qui ferait sortir une requete du
// client a chaque affichage.
//
// Une difference assumee : Node compte les graphemes pour refuser « deux
// emojis colles », ce qui demanderait ici une dependance de segmentation. Go
// borne donc l'emoji en runes. Node reste la porte stricte ; celle-ci refuse
// tout ce qui est franchement invalide.
func validWorkspaceIcon(icon string) bool {
	if len(icon) > 65536 {
		return false
	}
	if icon == "" {
		return true
	}
	if rest, found := strings.CutPrefix(icon, "icon:"); found {
		parts := strings.Split(rest, ":")
		if len(parts) > 2 {
			return false
		}
		for _, part := range parts {
			if len(part) < 1 || len(part) > 96 || strings.ContainsFunc(part, func(r rune) bool {
				return !(r == '_' || r == '-' || unicode.IsLetter(r) && r < 128 || unicode.IsDigit(r) && r < 128)
			}) {
				return false
			}
		}
		return true
	}
	if encoded, found := strings.CutPrefix(icon, "data:image/png;base64,"); found {
		if !strings.HasPrefix(encoded, "iVBORw0KGgo") {
			return false
		}
		png, e := base64.StdEncoding.DecodeString(encoded)
		if e != nil || len(png) < 45 || string(png[12:16]) != "IHDR" || string(png[len(png)-8:len(png)-4]) != "IEND" {
			return false
		}
		width := uint32(png[16])<<24 | uint32(png[17])<<16 | uint32(png[18])<<8 | uint32(png[19])
		height := uint32(png[20])<<24 | uint32(png[21])<<16 | uint32(png[22])<<8 | uint32(png[23])
		return width > 0 && width <= 96 && height > 0 && height <= 96
	}
	if len(icon) > 48 {
		return false
	}
	pictographic := false
	for _, r := range icon {
		if unicode.IsControl(r) {
			return false
		}
		if unicode.Is(unicode.So, r) {
			pictographic = true
		}
	}
	return pictographic
}
