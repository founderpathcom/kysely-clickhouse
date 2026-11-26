// ClickHouse has no client-side prepared statements over HTTP, so parameter values are written
// into the SQL text as literals. Everything in this file exists to make that safe: a value must
// always come out as exactly one literal, and only real placeholders may be substituted.

// Escapes what is special inside a quoted token: the backslash, the quote itself, and `$`.
//
// A dollar sign has no meaning inside quotes, but ClickHouse 24 looks for the closing tag of a
// heredoc (`$tag$ ... $tag$`) without regard for quotes. Written as `\x24`, a value can never
// supply that closing tag.
function escapeQuoted(value: string, quote: "'" | '`'): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\x24')
    .replace(quote === "'" ? /'/g : /`/g, quote === "'" ? "\\'" : '``')
}

/**
 * Escapes a string for use inside a single-quoted ClickHouse string literal (without the quotes).
 *
 * In ClickHouse SQL a backslash starts an escape sequence, so backslashes are escaped along with
 * single quotes. Escaping only the quotes lets a value such as `O\'Brien` close the literal early,
 * and the rest of the value is read as SQL.
 */
export function escapeStringLiteral(value: string): string {
  return escapeQuoted(value, "'")
}

/**
 * Escapes an identifier for use inside backticks (without the backticks).
 *
 * Unlike MySQL, ClickHouse treats a backslash inside a backtick-quoted identifier as an escape
 * character, so doubling the backticks alone is not enough: an identifier ending in a backslash
 * would escape the closing backtick.
 */
export function escapeIdentifier(identifier: string): string {
  return escapeQuoted(identifier, '`')
}

export function quoteIdentifier(identifier: string): string {
  return `\`${escapeIdentifier(identifier)}\``
}

function formatDate(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Cannot use an invalid Date as a query parameter.')
  }

  // A typed literal with an explicit time zone is the same instant whatever the time zone of the
  // server, the session or the column, and needs no `date_time_input_format` setting. A plain
  // string would be parsed in the time zone of the column it is compared to.
  const text = value.toISOString().replace('T', ' ').replace('Z', '')

  return `toDateTime64('${text}', 3, 'UTC')`
}

/**
 * Formats a JavaScript value as a ClickHouse SQL literal.
 */
export function formatValue(value: unknown): string {
  if (value === null) {
    return 'NULL'
  }

  switch (typeof value) {
    case 'string':
      return `'${escapeStringLiteral(value)}'`

    case 'number':
      if (Number.isNaN(value)) {
        return 'nan'
      }
      if (!Number.isFinite(value)) {
        return value > 0 ? 'inf' : '(-inf)'
      }
      // A bare negative number after a minus sign (`a - ?`) would produce `--`, which starts a
      // comment and silently drops the rest of the line.
      return value < 0 ? `(${value})` : `${value}`

    case 'bigint':
      return value < 0n ? `(${value})` : `${value}`

    case 'boolean':
      return value ? 'true' : 'false'

    case 'object': {
      if (value instanceof Date) {
        return formatDate(value)
      }
      if (Array.isArray(value)) {
        return `[${value.map(formatValue).join(', ')}]`
      }

      const json = JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? item.toString() : item,
      )
      if (typeof json === 'string') {
        return `'${escapeStringLiteral(json)}'`
      }
    }
  }

  // An undefined value is a mistake of the caller. Sending it as NULL, or as the text 'undefined',
  // would run a different query than the one that was meant, without anyone noticing.
  throw new TypeError(
    value === undefined
      ? 'Cannot use undefined as a query parameter. Use null for a NULL value.'
      : `Cannot use a value of type ${typeof value} as a query parameter.`,
  )
}

// Returns the index just past the quoted token that starts at `start`.
function skipQuoted(sql: string, start: number): number {
  const quote = sql[start]
  let i = start + 1

  while (i < sql.length) {
    const char = sql[i]

    if (char === '\\') {
      i += 2
    } else if (char !== quote) {
      i += 1
    } else if (sql[i + 1] === quote) {
      i += 2
    } else {
      return i + 1
    }
  }

  return sql.length
}

// Returns the index just past the first `end` found after `from`, or the end of the SQL.
function skipPast(sql: string, end: string, from: number): number {
  const index = sql.indexOf(end, from)

  return index === -1 ? sql.length : index + end.length
}

// ClickHouse block comments nest.
function skipBlockComment(sql: string, start: number): number {
  let depth = 0
  let i = start

  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1
      i += 2
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1
      i += 2

      if (depth === 0) {
        return i
      }
    } else {
      i += 1
    }
  }

  return sql.length
}

// Returns the index just past the heredoc (`$tag$ text $tag$`) that starts at `start`, or `start`
// when the dollar sign does not start one.
//
// Which tags are valid depends on the ClickHouse version. Any text between two dollar signs is
// taken as a tag here: reading too much as a heredoc can only make the placeholder count fail.
function skipHeredoc(sql: string, start: number): number {
  const tagEnd = sql.indexOf('$', start + 1)

  if (tagEnd === -1) {
    return start
  }

  const tag = sql.slice(start, tagEnd + 1)
  const close = sql.indexOf(tag, tagEnd + 1)

  return close === -1 ? start : close + tag.length
}

function placeholderError(placeholders: number, parameters: number): Error {
  return new Error(
    `The query has ${placeholders} "?" placeholder(s) but ${parameters} parameter(s). ` +
      'A "?" written directly in raw SQL (for example the "a ? b : c" operator) is read as a ' +
      'placeholder: use if(a, b, c) instead, or pass the text containing "?" as a parameter. ' +
      'A parameter cannot be used inside a comment, a heredoc or a quoted token.',
  )
}

/**
 * Replaces the `?` placeholders of a compiled query with literals.
 *
 * Only placeholders in SQL position are replaced. Inside a string literal, a quoted identifier, a
 * heredoc or a comment, a `?` is part of that token, and a value written there would not be read
 * as the literal it is formatted as: a line break in the value ends a line comment, for example,
 * and the rest of the value is read as SQL.
 *
 * This means reading the SQL the way ClickHouse does, for every token in which a `?` can hide.
 * The number of placeholders found has to match the number of parameters exactly, which turns
 * most disagreements into an error instead of a query with misplaced values.
 */
export function interpolateParameters(sql: string, parameters: ReadonlyArray<unknown>): string {
  const parts: string[] = []
  let placeholders = 0
  let copiedUpTo = 0
  let i = 0

  while (i < sql.length) {
    const char = sql[i]
    const next = sql[i + 1]

    if (char === "'" || char === '`' || char === '"') {
      i = skipQuoted(sql, i)
    } else if (char === '\u2018') {
      // Typographic quotes are accepted as quotes too, and have no escape sequences.
      i = skipPast(sql, '\u2019', i + 1)
    } else if (char === '\u201C') {
      i = skipPast(sql, '\u201D', i + 1)
    } else if (char === '$') {
      const end = skipHeredoc(sql, i)
      i = end === i ? i + 1 : end
    } else if (
      (char === '-' && next === '-') ||
      (char === '/' && next === '/') ||
      (char === '#' && (next === ' ' || next === '!'))
    ) {
      // `-- comment`, `// comment`, `# comment` and `#!comment` run to the end of the line.
      i = skipPast(sql, '\n', i)
    } else if (char === '/' && next === '*') {
      i = skipBlockComment(sql, i)
    } else if (char === '?') {
      if (placeholders < parameters.length) {
        parts.push(sql.slice(copiedUpTo, i), formatValue(parameters[placeholders]))
        copiedUpTo = i + 1
      }
      placeholders += 1
      i += 1
    } else {
      i += 1
    }
  }

  if (placeholders !== parameters.length) {
    throw placeholderError(placeholders, parameters.length)
  }

  parts.push(sql.slice(copiedUpTo))

  return parts.join('')
}
