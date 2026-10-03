import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A small, strict reader for the YAML subset the GitHub workflow files use: block mappings, block
// sequences, plain and quoted scalars, block scalars (| and >) and one-line flow sequences. Anything
// else (anchors, aliases, tags, flow mappings, multi-line plain scalars, tabs, several documents) throws,
// so a workflow written in a form this reader cannot check fails the security tests instead of passing
// unread. The `yaml` package is not a dependency of this repo, and no package is installed for tests.
// Scalars stay strings: `persist-credentials: false` reads as 'false'.

export type YamlValue = string | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

interface Line {
  no: number;
  indent: number;
  text: string; // the line without its indentation; comments not yet removed
}

class Reader {
  private i = 0;
  constructor(
    private readonly lines: Line[],
    private readonly file: string,
  ) {}

  fail(line: Line | undefined, why: string): never {
    throw new Error(`${this.file}:${line?.no ?? 'EOF'}: ${why}`);
  }

  /** The next line that holds content (not blank, not a whole-line comment). */
  peek(): Line | undefined {
    for (let line = this.lines[this.i]; line; line = this.lines[this.i]) {
      if (line.text === '' || line.text.startsWith('#')) {
        this.i += 1;
        continue;
      }
      return line;
    }
    return undefined;
  }

  done(): boolean {
    return this.peek() === undefined;
  }

  block(minIndent: number): YamlValue {
    const line = this.peek();
    if (!line || line.indent < minIndent) return null;
    return isSequenceItem(line.text) ? this.sequence(line.indent) : this.mapping(line.indent);
  }

  mapping(indent: number): YamlMap {
    const out: YamlMap = {};
    for (let line = this.peek(); line && line.indent >= indent; line = this.peek()) {
      if (line.indent > indent) this.fail(line, 'unexpected indentation');
      if (isSequenceItem(line.text)) break;
      const text = stripComment(line.text, line, this);
      const match =
        /^(?:"([^"]*)"|'([^']*)'|([^\s'"#&*!|>{[\]-][^#]*?|-[^\s#][^#]*?))\s*:(?:\s+(.*))?$/.exec(
          text,
        );
      if (!match) this.fail(line, `expected "key: value", got ${JSON.stringify(text)}`);
      const key = match[1] ?? match[2] ?? match[3] ?? '';
      if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(line, `duplicate key "${key}"`);
      const rest = (match[4] ?? '').trim();
      this.i += 1;
      if (rest === '') {
        const next = this.peek();
        if (next && next.indent > indent) out[key] = this.block(next.indent);
        else if (next && next.indent === indent && isSequenceItem(next.text))
          out[key] = this.sequence(indent);
        else out[key] = null;
      } else if (/^[|>][+-]?$/.test(rest)) {
        out[key] = this.blockScalar(indent, rest);
      } else {
        out[key] = scalar(rest, line, this);
      }
    }
    return out;
  }

  sequence(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (let line = this.peek(); line && line.indent >= indent; line = this.peek()) {
      if (line.indent > indent) this.fail(line, 'unexpected indentation');
      if (!isSequenceItem(line.text)) break;
      const item = stripComment(line.text.slice(1), line, this);
      const body = item.trimStart();
      if (body === '') {
        this.i += 1;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.block(next.indent) : null);
      } else if (/^(?:"[^"]*"|'[^']*'|[^\s'"#&*!|>{[\]][^#]*?)\s*:(?:\s|$)/.test(body)) {
        // "- key: value" opens a mapping whose keys sit two columns in. Re-read this line as that key.
        const keyIndent = indent + 1 + (item.length - body.length);
        this.lines[this.i] = {
          no: line.no,
          indent: keyIndent,
          text: line.text.slice(1).trimStart(),
        };
        out.push(this.mapping(keyIndent));
      } else {
        this.i += 1;
        out.push(scalar(body, line, this));
      }
    }
    return out;
  }

  blockScalar(parentIndent: number, indicator: string): string {
    const body: Line[] = [];
    for (let line = this.lines[this.i]; line; line = this.lines[this.i]) {
      if (line.text !== '' && line.indent <= parentIndent) break;
      body.push(line);
      this.i += 1;
    }
    while (body.at(-1)?.text === '') body.pop();
    const contentIndent = Math.min(...body.filter((l) => l.text !== '').map((l) => l.indent));
    const rows = body.map((l) =>
      l.text === '' ? '' : ' '.repeat(l.indent - contentIndent) + l.text,
    );
    const joined = indicator.startsWith('>') ? rows.join(' ') : rows.join('\n');
    return indicator.endsWith('-') ? joined : `${joined}\n`;
  }
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** Removes a trailing "# comment" that is outside quotes. */
function stripComment(text: string, line: Line, reader: Reader): string {
  let quote: '"' | "'" | null = null;
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (quote === '"') {
      if (ch === '\\') k += 1;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'" && text[k + 1] === "'") k += 1;
      else if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      // Quotes only open a quoted scalar at the start of a value; inside plain text they are literal.
      const before = text.slice(0, k).trimEnd();
      if (
        before === '' ||
        before.endsWith(':') ||
        before.endsWith('-') ||
        before.endsWith('[') ||
        before.endsWith(',')
      )
        quote = ch;
    } else if (ch === '#' && (k === 0 || text[k - 1] === ' ')) {
      return text.slice(0, k).trimEnd();
    }
  }
  if (quote) reader.fail(line, 'unterminated quoted string');
  return text.trimEnd();
}

function scalar(raw: string, line: Line, reader: Reader): YamlValue {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) reader.fail(line, `bad double-quoted scalar ${text}`);
    return JSON.parse(text) as string;
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) reader.fail(line, `bad single-quoted scalar ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) reader.fail(line, 'flow sequences must close on the same line');
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => scalar(part, line, reader));
  }
  if (/^[{&*!%@`]/.test(text) || text === '---' || text === '...')
    reader.fail(line, `unsupported YAML construct ${text}`);
  return text;
}

export function parseWorkflowYaml(source: string, file = '<yaml>'): YamlMap {
  const lines: Line[] = source.split(/\r?\n/).map((raw, index) => {
    const indentText = /^[ \t]*/.exec(raw)?.[0] ?? '';
    if (indentText.includes('\t')) throw new Error(`${file}:${index + 1}: tab in indentation`);
    const text = raw.slice(indentText.length).trimEnd();
    if (raw.startsWith('---') || raw.startsWith('...'))
      throw new Error(`${file}:${index + 1}: several YAML documents are not supported`);
    return { no: index + 1, indent: indentText.length, text };
  });
  const reader = new Reader(lines, file);
  const first = reader.peek();
  if (!first) throw new Error(`${file}: empty workflow`);
  if (first.indent !== 0 || isSequenceItem(first.text))
    reader.fail(first, 'a workflow must be a top-level mapping');
  const doc = reader.mapping(0);
  if (!reader.done()) reader.fail(reader.peek(), 'content after the top-level mapping');
  return doc;
}

export const WORKFLOW_DIR = '.github/workflows';

export interface Workflow {
  file: string;
  raw: string;
  doc: YamlMap;
}

export function loadWorkflows(dir = WORKFLOW_DIR): Workflow[] {
  return readdirSync(dir)
    .filter((name: string) => /\.ya?ml$/.test(name))
    .sort()
    .map((name: string) => {
      const file = join(dir, name).replace(/\\/g, '/');
      const raw = readFileSync(file, 'utf8');
      return { file, raw, doc: parseWorkflowYaml(raw, file) };
    });
}

export function asMap(value: YamlValue | undefined, what: string): YamlMap {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what} is not a mapping`);
  return value;
}

export function asList(value: YamlValue | undefined, what: string): YamlValue[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}

export function jobsOf(workflow: Workflow): [string, YamlMap][] {
  const jobs = asMap(workflow.doc['jobs'], `${workflow.file} jobs`);
  return Object.entries(jobs).map(([id, job]) => [id, asMap(job, `${workflow.file} job ${id}`)]);
}

export function stepsOf(job: YamlMap, what: string): YamlMap[] {
  return asList(job['steps'], `${what} steps`).map((step, n) =>
    asMap(step, `${what} step ${n + 1}`),
  );
}

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}
