package mimeutil

import (
	"bytes"
	"mime/quotedprintable"
	"regexp"
	"strings"
)

var (
	htmlTagRegex = regexp.MustCompile(`(?i)<[^>]+>`)
	headRegex    = regexp.MustCompile(`(?is)<head.*?</head>`)
	styleRegex   = regexp.MustCompile(`(?is)<style.*?</style>`)
	scriptRegex  = regexp.MustCompile(`(?is)<script.*?</script>`)
	brRegex      = regexp.MustCompile(`(?i)<br\s*/?>`)
	pRegex       = regexp.MustCompile(`(?i)</(p|div|tr|h[1-6])>`)
)

func IsLikelyHTML(s string) bool {
	trimmed := strings.TrimSpace(s)
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "<!doctype") ||
		strings.HasPrefix(lower, "<html") ||
		strings.HasPrefix(lower, "<body") ||
		strings.HasPrefix(lower, "<head") {
		return true
	}
	if strings.Contains(lower, "<html") && strings.Contains(lower, "</html>") {
		return true
	}
	if strings.Contains(lower, "<body") && strings.Contains(lower, "</body>") {
		return true
	}
	if strings.Contains(lower, "<table") && strings.Contains(lower, "</table>") {
		return true
	}
	if strings.Contains(lower, "<div") && strings.Contains(lower, "</div>") {
		return true
	}
	return false
}

func HTMLToText(html string) string {
	s := headRegex.ReplaceAllString(html, "")
	s = styleRegex.ReplaceAllString(s, "")
	s = scriptRegex.ReplaceAllString(s, "")
	s = brRegex.ReplaceAllString(s, "\n")
	s = pRegex.ReplaceAllString(s, "\n\n")
	s = htmlTagRegex.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&#39;", "'")
	lines := strings.Split(s, "\n")
	var cleaned []string
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	return strings.Join(cleaned, "\n\n")
}

func EncodeQuotedPrintable(s string) string {
	var buf bytes.Buffer
	w := quotedprintable.NewWriter(&buf)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	res := buf.String()
	if !strings.HasSuffix(res, "\r\n") {
		res = strings.TrimRight(res, "\r\n") + "\r\n"
	}
	return res
}

func SanitizeHeader(val string) string {
	val = strings.ReplaceAll(val, "\r", "")
	val = strings.ReplaceAll(val, "\n", "")
	return strings.TrimSpace(val)
}
