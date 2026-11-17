const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
// Read tokens left to right, as CSS does: a url( inside a string loads nothing, and a quote in an
// unquoted url( is not a string. A quoted url() that is not data: or #id keeps `url(` for the check.
const URL_OR_STRING =
  /url\((?![ \t\n\f\r]*["'])[^)]*|url\([ \t\n\f\r]*("[^"\n\r\f]*"|'[^'\n\r\f]*')|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi;

function fetchesByText(code: string): boolean {
  const outsideStrings = code.replace(URL_OR_STRING, (token, urlString: string | undefined) => {
    if (urlString !== undefined) return /^["'](?:data:|#)/i.test(urlString) ? "" : "url(";
    return token.startsWith('"') || token.startsWith("'") ? "" : token;
  });
  return FETCHES_BY_STRING.test(outsideStrings) || URL_NOT_LOCAL.test(outsideStrings);
}

/**
 * Whether one declaration value can load a remote file. Clients drop those declarations.
 * A value with var() stays unparsed until use, and an escape can spell `var` or `url` in it,
 * so every value that still has a backslash is refused.
 */
export function themeCssValueFetches(value: string): boolean {
  return value.includes("\\") || fetchesByText(value);
}

/** A text check for early feedback. CSS escapes can dodge it; the client check is the guard. */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return /@import/i.test(code) || fetchesByText(code);
}
