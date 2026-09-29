// Package expr implements a small, safe expression language used by mock rules.
//
// Values are JSON-like: bool, float64, string, nil, []any, map[string]any.
// Supported syntax:
//
//	{{ expr }} template interpolation inside response text
//	paths: body.items.0.name, query.page, headers.X-Custom, path.id, state.count, calls
//	literals: "str", 12, 1.5, true/false, null
//	arithmetic: + - * / % ; comparison: == != > >= < <= ; logical: && || !
//	functions: now(), uuid(), json(x), if(cond, a, b), length(x), concat(...)
package expr

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type Context struct {
	Body    any
	Query   map[string]any
	Headers map[string]any
	Path    map[string]any
	State   map[string]any
	Calls   int
}

// Eval evaluates a standalone expression (used by conditions/operations).
func Eval(source string, c *Context) (any, error) {
	t := newTokenizer(source)
	p := &parser{t: t, c: c}
	v, err := p.parseExpr()
	if err != nil {
		return nil, err
	}
	if p.t.peekTok().kind != tokEOF {
		return nil, fmt.Errorf("unexpected token %q", p.t.peekTok().text)
	}
	return v, nil
}

// Render replaces {{ ... }} segments in text with evaluated values.
// Whitespace segments are rendered as JSON so output stays valid JSON.
func Render(text string, c *Context) (string, error) {
	var b strings.Builder
	for {
		open := strings.Index(text, "{{")
		if open < 0 {
			b.WriteString(text)
			return b.String(), nil
		}
		b.WriteString(text[:open])
		text = text[open+2:]
		close := strings.Index(text, "}}")
		if close < 0 {
			return "", fmt.Errorf("unterminated {{ expression")
		}
		expression := strings.TrimSpace(text[:close])
		text = text[close+2:]
		v, err := Eval(expression, c)
		if err != nil {
			return "", err
		}
		writeRendered(&b, v)
	}
}

func writeRendered(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case string:
		b.WriteString(x)
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case float64:
		b.WriteString(formatNumber(x))
	default:
		// objects/arrays render as JSON-compatible output
		b.WriteString(toJSON(v))
	}
}

func formatNumber(f float64) string {
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// ResolveField reads body.x / query.x / headers.x / path.x / state.x / calls.
func ResolveField(field string, c *Context) (any, error) {
	field = strings.TrimSpace(field)
	if field == "calls" {
		return float64(c.Calls), nil
	}
	if field == "body" {
		return c.Body, nil
	}
	root, rest, ok := splitRoot(field)
	if !ok {
		return nil, fmt.Errorf("unknown field %q (use body./query./headers./path./state./calls)", field)
	}
	var base any
	switch root {
	case "body":
		base = c.Body
	case "query":
		base = c.Query
	case "headers":
		base = c.Headers
	case "path":
		base = c.Path
	case "state":
		base = c.State
	default:
		return nil, fmt.Errorf("unknown field root %q", root)
	}
	return dig(base, rest), nil
}

func splitRoot(field string) (string, string, bool) {
	i := strings.Index(field, ".")
	if i < 0 {
		if field == "body" {
			return "body", "", true
		}
		return "", "", false
	}
	return field[:i], field[i+1:], true
}

func dig(base any, path string) any {
	if path == "" {
		return base
	}
	cur := base
	for _, part := range strings.Split(path, ".") {
		switch m := cur.(type) {
		case map[string]any:
			cur = m[part]
			cur = m[part]
		case []any:
			if i, err := strconv.Atoi(part); err == nil && i >= 0 && i < len(m) {
				cur = m[i]
			} else {
				return nil
			}
		default:
			return nil
		}
	}
	return cur
}

// ---------- tokenizer ----------

type tokenKind int

const (
	tokEOF tokenKind = iota
	tokNumber
	tokString
	tokIdent
	tokOp
	tokLParen
	tokRParen
	tokLBracket
	tokRBracket
	tokComma
)

type token struct {
	kind tokenKind
	text string
}

type tokenizer struct {
	src    string
	pos    int
	buf    []token
	pushed bool
}

func newTokenizer(src string) *tokenizer { return &tokenizer{src: src} }

func (z *tokenizer) skipSpace() {
	for z.pos < len(z.src) {
		ch := z.src[z.pos]
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
			z.pos++
		} else {
			return
		}
	}
}

var twoCharOps = map[string]bool{"==": true, "!=": true, ">=": true, "<=": true, "&&": true, "||": true}

func (z *tokenizer) next() token {
	if len(z.buf) > 0 {
		t := z.buf[len(z.buf)-1]
		z.buf = z.buf[:len(z.buf)-1]
		return t
	}
	z.skipSpace()
	if z.pos >= len(z.src) {
		return token{kind: tokEOF}
	}
	ch := z.src[z.pos]
	switch {
	case ch == '(':
		z.pos++
		return token{tokLParen, "("}
	case ch == ')':
		z.pos++
		return token{tokRParen, ")"}
	case ch == '[':
		z.pos++
		return token{tokLBracket, "["}
	case ch == ']':
		z.pos++
		return token{tokRBracket, "]"}
	case ch == ',':
		z.pos++
		return token{tokComma, ","}
	case ch == '"' || ch == '\'':
		quote := ch
		z.pos++
		var sb strings.Builder
		for z.pos < len(z.src) && z.src[z.pos] != quote {
			if z.src[z.pos] == '\\' && z.pos+1 < len(z.src) {
				sb.WriteByte(escapeChar(z.src[z.pos+1]))
				z.pos += 2
			} else {
				sb.WriteByte(z.src[z.pos])
				z.pos++
			}
		}
		if z.pos < len(z.src) {
			z.pos++ // closing quote
		}
		return token{tokString, sb.String()}
	case ch >= '0' && ch <= '9', ch == '.' && z.pos+1 < len(z.src) && z.src[z.pos+1] >= '0' && z.src[z.pos+1] <= '9':
		begin := z.pos
		for z.pos < len(z.src) && ((z.src[z.pos] >= '0' && z.src[z.pos] <= '9') || z.src[z.pos] == '.') {
			z.pos++
		}
		return token{tokNumber, z.src[begin:z.pos]}
	case isIdentStart(ch):
		begin := z.pos
		for z.pos < len(z.src) && isIdentPart(z.src[z.pos]) {
			z.pos++
		}
		return token{tokIdent, z.src[begin:z.pos]}
	default:
		if z.pos+1 < len(z.src) && twoCharOps[z.src[z.pos:z.pos+2]] {
			t := token{tokOp, z.src[z.pos : z.pos+2]}
			z.pos += 2
			return t
		}
		if strings.ContainsRune("+-*/%=!&|><", rune(ch)) {
			z.pos++
			return token{tokOp, string(ch)}
		}
		// Unknown character: skip it to avoid infinite loop; parser will usually fail.
		z.pos++
		return z.next()
	}
}

func escapeChar(ch byte) byte {
	switch ch {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	}
	return ch
}

func (z *tokenizer) peekTok() token {
	t := z.next()
	z.unread(t)
	return t
}

func (z *tokenizer) unread(t token) {
	z.buf = append(z.buf, t)
}

func isIdentStart(ch byte) bool {
	return ch == '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

func isIdentPart(ch byte) bool {
	return isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch == '.'
}

// ---------- parser ----------

type parser struct {
	t *tokenizer
	c *Context
}

func (p *parser) parseExpr() (any, error) { return p.parseOr() }

func (p *parser) parseOr() (any, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.t.peekTok().kind == tokOp && p.t.peekTok().text == "||" {
		p.t.next()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = asBool(left) || asBool(right)
	}
	return left, nil
}

func (p *parser) parseAnd() (any, error) {
	left, err := p.parseCmp()
	if err != nil {
		return nil, err
	}
	for p.t.peekTok().kind == tokOp && p.t.peekTok().text == "&&" {
		p.t.next()
		right, err := p.parseCmp()
		if err != nil {
			return nil, err
		}
		left = asBool(left) && asBool(right)
	}
	return left, nil
}

func (p *parser) parseCmp() (any, error) {
	left, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	for {
		tk := p.t.peekTok()
		if tk.kind != tokOp || (tk.text != "==" && tk.text != "!=" && tk.text != ">" && tk.text != ">=" && tk.text != "<" && tk.text != "<=") {
			return left, nil
		}
		p.t.next()
		right, err := p.parseAdd()
		if err != nil {
			return nil, err
		}
		var res bool
		res, err = compare(tk.text, left, right)
		if err != nil {
			return nil, err
		}
		left = res
	}
}

func (p *parser) parseAdd() (any, error) {
	left, err := p.parseMul()
	if err != nil {
		return nil, err
	}
	for {
		tk := p.t.peekTok()
		if tk.kind != tokOp || (tk.text != "+" && tk.text != "-") {
			return left, nil
		}
		p.t.next()
		right, err := p.parseMul()
		if err != nil {
			return nil, err
		}
		left, err = arith(tk.text, left, right)
		if err != nil {
			return nil, err
		}
	}
}

func (p *parser) parseMul() (any, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		tk := p.t.peekTok()
		if tk.kind != tokOp || (tk.text != "*" && tk.text != "/" && tk.text != "%") {
			return left, nil
		}
		p.t.next()
		right, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		left, err = arith(tk.text, left, right)
		if err != nil {
			return nil, err
		}
	}
}

func (p *parser) parseUnary() (any, error) {
	tk := p.t.peekTok()
	if tk.kind == tokOp && (tk.text == "!" || tk.text == "-") {
		p.t.next()
		v, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		if tk.text == "!" {
			return !asBool(v), nil
		}
		n, ok := asNumber(v)
		if !ok {
			return nil, fmt.Errorf("unary - expects number, got %T", v)
		}
		return -n, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (any, error) {
	tk := p.t.next()
	switch tk.kind {
	case tokEOF:
		return nil, fmt.Errorf("unexpected end of expression")
	case tokNumber:
		f, err := strconv.ParseFloat(tk.text, 64)
		if err != nil {
			return nil, err
		}
		return f, nil
	case tokString:
		return tk.text, nil
	case tokLParen:
		v, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		if p.t.next().kind != tokRParen {
			return nil, fmt.Errorf("missing closing parenthesis")
		}
		return v, nil
	case tokIdent:
		name := tk.text
		if p.t.peekTok().kind == tokLParen {
			p.t.next()
			var args []any
			if p.t.peekTok().kind != tokRParen {
				for {
					v, err := p.parseExpr()
					if err != nil {
						return nil, err
					}
					args = append(args, v)
					if p.t.peekTok().kind == tokComma {
						p.t.next()
						continue
					}
					break
				}
			}
			if p.t.next().kind != tokRParen {
				return nil, fmt.Errorf("missing ) after %s(...) ", name)
			}
			return callFunc(name, args)
		}
		return identValue(name, p.c)
	default:
		return nil, fmt.Errorf("unexpected token %q", tk.text)
	}
}

func identValue(name string, c *Context) (any, error) {
	switch name {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "null":
		return nil, nil
	}
	return ResolveField(name, c)
}

func callFunc(name string, args []any) (any, error) {
	switch name {
	case "now":
		if len(args) != 0 {
			return nil, fmt.Errorf("now() takes no args")
		}
		return float64(time.Now().UnixMilli()), nil
	case "uuid":
		if len(args) != 0 {
			return nil, fmt.Errorf("uuid() takes no args")
		}
		var b [12]byte
		_, _ = rand.Read(b[:])
		hexStr := hex.EncodeToString(b[:])
		return fmt.Sprintf("%s-%s-%s-%s-%s", hexStr[0:8], hexStr[8:12], hexStr[12:16], hexStr[16:20], hexStr[20:]), nil
	case "if":
		if len(args) != 3 {
			return nil, fmt.Errorf("if(cond, a, b) takes 3 args")
		}
		if asBool(args[0]) {
			return args[1], nil
		}
		return args[2], nil
	case "length":
		if len(args) != 1 {
			return nil, fmt.Errorf("length(x) takes 1 arg")
		}
		switch v := args[0].(type) {
		case string:
			return float64(len(v)), nil
		case []any:
			return float64(len(v)), nil
		case map[string]any:
			return float64(len(v)), nil
		case nil:
			return float64(0), nil
		}
		return nil, fmt.Errorf("length: unsupported type %T", args[0])
	case "concat":
		var sb strings.Builder
		for _, a := range args {
			sb.WriteString(stringify(a))
		}
		return sb.String(), nil
	case "json":
		if len(args) != 1 {
			return nil, fmt.Errorf("json(x) takes 1 arg")
		}
		return toJSON(args[0]), nil
	}
	return nil, fmt.Errorf("unknown function %q", name)
}

func arith(op string, a, b any) (any, error) {
	if op == "+" {
		if as1, ok1 := a.(string); ok1 {
			return as1 + stringify(b), nil
		}
		if bs, ok2 := b.(string); ok2 {
			return stringify(a) + bs, nil
		}
	}
	x, ok1 := asNumber(a)
	y, ok2 := asNumber(b)
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("operator %q needs numbers (got %T, %T)", op, a, b)
	}
	switch op {
	case "+":
		return x + y, nil
	case "-":
		return x - y, nil
	case "*":
		return x * y, nil
	case "/":
		if y == 0 {
			return nil, fmt.Errorf("division by zero")
		}
		return x / y, nil
	case "%":
		if y == 0 {
			return nil, fmt.Errorf("modulo by zero")
		}
		return float64(int64(x) % int64(y)), nil
	}
	return nil, fmt.Errorf("unknown operator %q", op)
}

func compare(op string, a, b any) (bool, error) {
	switch op {
	case "==":
		return equal(a, b), nil
	case "!=":
		return !equal(a, b), nil
	}
	x, ok1 := asNumber(a)
	y, ok2 := asNumber(b)
	if !ok1 || !ok2 {
		return false, fmt.Errorf("operator %q needs numbers (got %T, %T)", op, a, b)
	}
	switch op {
	case ">":
		return x > y, nil
	case ">=":
		return x >= y, nil
	case "<":
		return x < y, nil
	case "<=":
		return x <= y, nil
	}
	return false, fmt.Errorf("unknown comparison %q", op)
}

func equal(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return stringify(a) == stringify(b) || numEqual(a, b)
}

func numEqual(a, b any) bool {
	x, ok1 := asNumber(a)
	y, ok2 := asNumber(b)
	return ok1 && ok2 && x == y
}

func asNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func asBool(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return formatNumber(x)
	default:
		return toJSON(v)
	}
}
