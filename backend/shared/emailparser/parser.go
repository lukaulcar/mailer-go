package emailparser

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"mailer-go/backend/shared/models"
)

type ParsedEmail struct {
	Subject     string
	From        string
	To          []string
	Headers     map[string]string
	TextBody    string
	HTMLBody    string
	Attachments []*models.Attachment
}

var wordDecoder = &mime.WordDecoder{}

func DecodeHeader(val string) string {
	if val == "" {
		return ""
	}
	decoded, err := wordDecoder.DecodeHeader(val)
	if err == nil && decoded != "" {
		return decoded
	}
	return val
}

func IsMultipartOrEncoded(s string) bool {
	trimmed := strings.TrimSpace(s)
	if strings.HasPrefix(trimmed, "--") && (strings.Contains(trimmed, "Content-Type:") || strings.Contains(trimmed, "content-type:")) {
		return true
	}
	if strings.Contains(trimmed, "Content-Transfer-Encoding:") || strings.Contains(trimmed, "content-transfer-encoding:") {
		return true
	}
	return false
}

func ParseEmail(rawBytes []byte) *ParsedEmail {
	res := &ParsedEmail{
		Headers:     make(map[string]string),
		Attachments: make([]*models.Attachment, 0),
	}

	rawStr := string(rawBytes)
	trimmed := strings.TrimSpace(rawStr)

	if strings.HasPrefix(trimmed, "--") && (strings.Contains(trimmed, "Content-Type:") || strings.Contains(trimmed, "content-type:")) {
		plain, htmlBody, atts := ParseMultipartSnippet(trimmed)
		res.TextBody = plain
		res.HTMLBody = htmlBody
		res.Attachments = atts
		return res
	}

	msg, err := mail.ReadMessage(bytes.NewReader(rawBytes))
	if err != nil {
		if IsMultipartOrEncoded(rawStr) {
			plain, htmlBody, atts := ParseMultipartSnippet(rawStr)
			res.TextBody = plain
			res.HTMLBody = htmlBody
			res.Attachments = atts
			return res
		}
		res.TextBody = rawStr
		return res
	}

	for k, v := range msg.Header {
		if len(v) > 0 {
			res.Headers[k] = DecodeHeader(v[0])
		}
	}

	if s := msg.Header.Get("Subject"); s != "" {
		res.Subject = DecodeHeader(s)
	} else if s := res.Headers["Subject"]; s != "" {
		res.Subject = s
	} else {
		res.Subject = "(No Subject)"
	}

	if from := msg.Header.Get("From"); from != "" {
		res.From = DecodeHeader(from)
	} else if from := res.Headers["From"]; from != "" {
		res.From = from
	}

	toVal := msg.Header.Get("To")
	if toVal == "" {
		toVal = res.Headers["To"]
	}
	if toVal != "" {
		if addrs, err := mail.ParseAddressList(toVal); err == nil {
			for _, a := range addrs {
				res.To = append(res.To, a.Address)
			}
		} else {
			res.To = []string{toVal}
		}
	}

	contentType := msg.Header.Get("Content-Type")
	contentTransferEncoding := msg.Header.Get("Content-Transfer-Encoding")

	plain, htmlBody, atts := parsePart(msg.Body, contentType, contentTransferEncoding)
	res.TextBody = plain
	res.HTMLBody = ResolveCIDImages(htmlBody, atts)
	res.Attachments = atts

	if strings.TrimSpace(res.TextBody) == "" && strings.TrimSpace(res.HTMLBody) != "" {
		res.TextBody = StripHTML(res.HTMLBody)
	}

	return res
}

func ParseBody(body string, contentType string) (textBody, htmlBody string) {
	trimmed := strings.TrimSpace(body)
	if IsMultipartOrEncoded(trimmed) {
		plain, htmlContent, atts := ParseMultipartSnippet(trimmed)
		if plain != "" || htmlContent != "" {
			if strings.TrimSpace(plain) == "" && strings.TrimSpace(htmlContent) != "" {
				plain = StripHTML(htmlContent)
			}
			return plain, ResolveCIDImages(htmlContent, atts)
		}
	}

	if contentType != "" {
		plain, htmlContent, atts := parsePart(strings.NewReader(body), contentType, "")
		if strings.TrimSpace(plain) == "" && strings.TrimSpace(htmlContent) != "" {
			plain = StripHTML(htmlContent)
		}
		return plain, ResolveCIDImages(htmlContent, atts)
	}

	return body, ""
}

func ParseMultipartSnippet(snippet string) (plain string, html string, atts []*models.Attachment) {
	trimmed := strings.TrimSpace(snippet)
	lines := strings.SplitN(trimmed, "\n", 2)
	if len(lines) == 0 {
		return snippet, "", nil
	}

	firstLine := strings.TrimSpace(lines[0])
	if !strings.HasPrefix(firstLine, "--") {
		return snippet, "", nil
	}

	boundary := strings.TrimPrefix(firstLine, "--")
	boundary = strings.TrimSuffix(boundary, "--")
	boundary = strings.TrimSpace(boundary)

	if boundary == "" {
		return snippet, "", nil
	}

	plain, html, atts = parseMultipartReader(strings.NewReader(snippet), boundary)
	html = ResolveCIDImages(html, atts)
	return plain, html, atts
}

func parsePart(r io.Reader, contentType string, transferEncoding string) (plain string, html string, atts []*models.Attachment) {
	if contentType == "" {
		contentType = "text/plain; charset=utf-8"
	}

	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		lowerCT := strings.ToLower(contentType)
		if strings.Contains(lowerCT, "multipart/") {
			mediaType = "multipart/mixed"
			re := regexp.MustCompile(`(?i)boundary="?([^";\r\n]+)"?`)
			if m := re.FindStringSubmatch(contentType); len(m) > 1 {
				params = map[string]string{"boundary": m[1]}
			}
		} else if strings.Contains(lowerCT, "text/html") {
			mediaType = "text/html"
		} else {
			mediaType = "text/plain"
		}
	}

	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			raw, _ := io.ReadAll(r)
			return ParseMultipartSnippet(string(raw))
		}
		return parseMultipartReader(r, boundary)
	}

	decodedBytes, err := decodeTransferEncoding(r, transferEncoding)
	if err != nil {
		decodedBytes, _ = io.ReadAll(r)
	}

	charset := params["charset"]
	content := decodeCharset(decodedBytes, charset)

	if strings.EqualFold(mediaType, "text/html") {
		return "", content, nil
	}
	return content, "", nil
}

const maxMultipartParts = 100

func parseMultipartReader(r io.Reader, boundary string, depth ...int) (plain string, html string, atts []*models.Attachment) {
	currentDepth := 0
	if len(depth) > 0 {
		currentDepth = depth[0]
	}
	if currentDepth > 10 {
		return "", "", nil
	}

	mr := multipart.NewReader(r, boundary)
	partCount := 0

	for {
		if partCount >= maxMultipartParts {
			break
		}
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		partCount++

		partCT := part.Header.Get("Content-Type")
		partCTE := part.Header.Get("Content-Transfer-Encoding")
		partCD := part.Header.Get("Content-Disposition")
		partCID := strings.Trim(part.Header.Get("Content-ID"), "<> \t\r\n")

		dispType, dispParams, _ := mime.ParseMediaType(partCD)
		mediaType, partParams, _ := mime.ParseMediaType(partCT)

		filename := dispParams["filename"]
		if filename == "" {
			filename = partParams["name"]
		}

		isInline := strings.EqualFold(dispType, "inline") || partCID != ""
		isExplicitAttachment := strings.EqualFold(dispType, "attachment")

		if strings.HasPrefix(mediaType, "multipart/") {
			nestedBoundary := partParams["boundary"]
			if nestedBoundary != "" {
				subPlain, subHTML, subAtts := parseMultipartReader(part, nestedBoundary, currentDepth+1)
				if plain == "" && subPlain != "" {
					plain = subPlain
				}
				if html == "" && subHTML != "" {
					html = subHTML
				}
				atts = append(atts, subAtts...)
			}
			continue
		}

		if strings.EqualFold(mediaType, "text/html") && filename == "" && partCID == "" && !isExplicitAttachment {
			decodedBytes, _ := decodeTransferEncoding(part, partCTE)
			charset := partParams["charset"]
			content := decodeCharset(decodedBytes, charset)
			if html == "" {
				html = content
			}
			continue
		}

		if strings.EqualFold(mediaType, "text/plain") && filename == "" && partCID == "" && !isExplicitAttachment {
			decodedBytes, _ := decodeTransferEncoding(part, partCTE)
			charset := partParams["charset"]
			content := decodeCharset(decodedBytes, charset)
			if plain == "" {
				plain = content
			}
			continue
		}

		data, _ := decodeTransferEncoding(part, partCTE)
		if filename == "" {
			if partCID != "" {
				filename = partCID
			} else {
				ext := defaultExtensionForContentType(mediaType)
				filename = fmt.Sprintf("attachment_%d%s", len(atts)+1, ext)
			}
		}

		atts = append(atts, &models.Attachment{
			ID:          fmt.Sprintf("att_%d_%d", time.Now().UnixNano(), len(atts)+1),
			Filename:    DecodeHeader(filename),
			ContentType: mediaType,
			SizeBytes:   int64(len(data)),
			Data:        data,
			ContentID:   partCID,
			IsInline:    isInline,
		})
	}

	return plain, html, atts
}

func defaultExtensionForContentType(ct string) string {
	lower := strings.ToLower(strings.TrimSpace(ct))
	if i := strings.Index(lower, ";"); i != -1 {
		lower = strings.TrimSpace(lower[:i])
	}
	switch lower {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "image/svg+xml":
		return ".svg"
	case "application/pdf":
		return ".pdf"
	case "application/zip":
		return ".zip"
	case "application/x-tar", "application/gzip":
		return ".tar.gz"
	case "text/plain":
		return ".txt"
	case "text/html":
		return ".html"
	case "text/csv":
		return ".csv"
	case "application/json":
		return ".json"
	default:
		return ".bin"
	}
}

func isSafeRasterImageMime(ct string) bool {
	lower := strings.ToLower(strings.TrimSpace(ct))
	if i := strings.Index(lower, ";"); i != -1 {
		lower = strings.TrimSpace(lower[:i])
	}
	switch lower {
	case "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon":
		return true
	default:
		return false
	}
}

func ResolveCIDImages(htmlBody string, atts []*models.Attachment) string {
	if htmlBody == "" || len(atts) == 0 {
		return htmlBody
	}

	result := htmlBody
	for _, att := range atts {
		if att == nil || len(att.Data) == 0 {
			continue
		}

		if !strings.Contains(strings.ToLower(result), "cid:") {
			break
		}

		if len(att.Data) > getMaxInlineImageBytes() {
			continue
		}
		if !isSafeRasterImageMime(att.ContentType) {
			continue
		}

		b64Data := base64.StdEncoding.EncodeToString(att.Data)
		cleanCT := strings.TrimSpace(att.ContentType)
		if i := strings.Index(cleanCT, ";"); i != -1 {
			cleanCT = strings.TrimSpace(cleanCT[:i])
		}
		dataURI := fmt.Sprintf("data:%s;base64,%s", cleanCT, b64Data)

		var searchKeys []string
		if att.ContentID != "" {
			cleanCID := strings.Trim(att.ContentID, "<>")
			searchKeys = append(searchKeys, att.ContentID, cleanCID)
		}
		if att.Filename != "" {
			searchKeys = append(searchKeys, att.Filename)
		}

		seen := make(map[string]bool)
		for _, key := range searchKeys {
			cleanKey := strings.TrimSpace(key)
			if cleanKey == "" || len(cleanKey) > 256 || seen[cleanKey] {
				continue
			}
			seen[cleanKey] = true

			escapedKey := regexp.QuoteMeta(cleanKey)

			rePattern := fmt.Sprintf(`(?i)(src|background)\s*=\s*(["']?)cid:(?:<%s>|%s)(["']?)`, escapedKey, escapedKey)
			if re, err := regexp.Compile(rePattern); err == nil {
				result = re.ReplaceAllString(result, fmt.Sprintf("${1}=${2}%s${3}", dataURI))
			}

			rePatternCSS := fmt.Sprintf(`(?i)url\((["']?)cid:(?:<%s>|%s)(["']?)\)`, escapedKey, escapedKey)
			if reCSS, err := regexp.Compile(rePatternCSS); err == nil {
				result = reCSS.ReplaceAllString(result, fmt.Sprintf("url(${1}%s${2})", dataURI))
			}

			urlKey := url.QueryEscape(cleanKey)
			if urlKey != cleanKey && len(urlKey) <= 256 {
				escapedURLKey := regexp.QuoteMeta(urlKey)
				rePatternURL := fmt.Sprintf(`(?i)(src|background)\s*=\s*(["']?)cid:(?:<%s>|%s)(["']?)`, escapedURLKey, escapedURLKey)
				if reURL, err := regexp.Compile(rePatternURL); err == nil {
					result = reURL.ReplaceAllString(result, fmt.Sprintf("${1}=${2}%s${3}", dataURI))
				}
				rePatternURLCSS := fmt.Sprintf(`(?i)url\((["']?)cid:(?:<%s>|%s)(["']?)\)`, escapedURLKey, escapedURLKey)
				if reURLCSS, err := regexp.Compile(rePatternURLCSS); err == nil {
					result = reURLCSS.ReplaceAllString(result, fmt.Sprintf("url(${1}%s${2})", dataURI))
				}
			}
		}
	}

	return result
}

func getMaxInlineImageBytes() int {
	maxMB := 10
	if val := os.Getenv("MAX_INLINE_IMAGE_MB"); val != "" {
		if n, err := strconv.Atoi(val); err == nil && n > 0 {
			maxMB = n
		}
	}
	return maxMB * 1024 * 1024
}

func getMaxPartSizeBytes() int64 {
	maxMB := int64(25)
	if val := os.Getenv("MAX_PART_SIZE_MB"); val != "" {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil && n > 0 {
			maxMB = n
		}
	}
	return maxMB * 1024 * 1024
}

func decodeTransferEncoding(r io.Reader, encoding string) ([]byte, error) {
	limitedReader := io.LimitReader(r, getMaxPartSizeBytes())
	enc := strings.ToLower(strings.TrimSpace(encoding))
	switch enc {
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(limitedReader))
	case "base64":
		raw, err := io.ReadAll(limitedReader)
		if err != nil {
			return nil, err
		}
		cleaned := strings.Map(func(c rune) rune {
			if c == '\r' || c == '\n' || c == ' ' || c == '\t' {
				return -1
			}
			return c
		}, string(raw))
		decoded, err := base64.StdEncoding.DecodeString(cleaned)
		if err != nil {
			decoded, err = base64.RawStdEncoding.DecodeString(cleaned)
			if err != nil {
				return raw, nil
			}
		}
		return decoded, nil
	default:
		return io.ReadAll(limitedReader)
	}
}

func decodeCharset(data []byte, charset string) string {
	cs := strings.ToLower(strings.Trim(charset, `"' `))
	if cs == "" || cs == "utf-8" || cs == "utf8" || cs == "us-ascii" || cs == "ascii" {
		return string(data)
	}

	if cs == "iso-8859-1" || cs == "latin1" || cs == "windows-1252" || cs == "cp1252" {
		var sb strings.Builder
		sb.Grow(len(data))
		for _, b := range data {
			sb.WriteRune(windows1252ToRune(b))
		}
		return sb.String()
	}

	return string(data)
}

func windows1252ToRune(b byte) rune {
	if b < 0x80 {
		return rune(b)
	}
	switch b {
	case 0x80:
		return '€'
	case 0x82:
		return '‚'
	case 0x83:
		return 'ƒ'
	case 0x84:
		return '„'
	case 0x85:
		return '…'
	case 0x86:
		return '†'
	case 0x87:
		return '‡'
	case 0x88:
		return 'ˆ'
	case 0x89:
		return '‰'
	case 0x8A:
		return 'Š'
	case 0x8B:
		return '‹'
	case 0x8C:
		return 'Œ'
	case 0x8E:
		return 'Ž'
	case 0x91:
		return '‘'
	case 0x92:
		return '’'
	case 0x93:
		return '“'
	case 0x94:
		return '”'
	case 0x95:
		return '•'
	case 0x96:
		return '–'
	case 0x97:
		return '—'
	case 0x98:
		return '˜'
	case 0x99:
		return '™'
	case 0x9A:
		return 'š'
	case 0x9B:
		return '›'
	case 0x9C:
		return 'œ'
	case 0x9E:
		return 'ž'
	case 0x9F:
		return 'Ÿ'
	default:
		return rune(b)
	}
}

var (
	tagRe       = regexp.MustCompile(`(?s)<[^>]+>`)
	styleRe     = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	scriptRe    = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	breakRe     = regexp.MustCompile(`(?i)<br\s*/?>|</p>|</div>|</tr>|</li>`)
	multiLineRe = regexp.MustCompile(`\n{3,}`)
)

func StripHTML(htmlStr string) string {
	s := styleRe.ReplaceAllString(htmlStr, "")
	s = scriptRe.ReplaceAllString(s, "")
	s = breakRe.ReplaceAllString(s, "\n")
	s = tagRe.ReplaceAllString(s, "")
	s = html.UnescapeString(s)

	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r")
	}
	res := strings.Join(lines, "\n")
	res = multiLineRe.ReplaceAllString(res, "\n\n")
	return strings.TrimSpace(res)
}
