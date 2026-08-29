/**
 * Generates the OpenAPI document and the readable API page.
 *
 *   pnpm docs:api          write them
 *   pnpm docs:api --check  fail if they are stale, or if a route has no entry
 *
 * Both outputs come from `src/shared/api/registry.ts`, whose request shapes are
 * the SAME Zod schemas the handlers validate with — so the documentation cannot
 * describe a field the server rejects.
 *
 * The `--check` mode is the point. Hand-written API documentation drifts within
 * a month; generated documentation drifts the moment somebody stops
 * regenerating it. CI runs the check, so both failures are build failures.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ENDPOINTS, COMMON_FAILURES, type Endpoint } from '../src/shared/api/registry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'src', 'app', 'api');
const OPENAPI_PATH = join(ROOT, 'docs', 'openapi.json');
const MARKDOWN_PATH = join(ROOT, 'docs', 'API.md');

const check = process.argv.includes('--check');

// ── the routes that actually exist ───────────────────────────────────────────

/**
 * Walks `src/app/api` for `route.ts` files and reads which methods each exports.
 *
 * The filesystem is the truth about what is reachable; the registry is a claim
 * about it. Comparing them is what stops the documentation quietly describing a
 * different API from the one running.
 */
async function actualRoutes(): Promise<Set<string>> {
  const found = new Set<string>();

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.name !== 'route.ts') continue;

      const source = await readFile(full, 'utf8');
      const urlPath =
        '/api/' +
        relative(API_DIR, dir).split(/[\\/]/).filter(Boolean)
          // `[id]` in the filesystem is `{id}` in OpenAPI.
          .map((s) => (s.startsWith('[') ? `{${s.slice(1, -1)}}` : s))
          .join('/');

      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const) {
        if (new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`).test(source)) {
          found.add(`${method} ${urlPath}`);
        }
      }
    }
  }

  await walk(API_DIR);
  return found;
}

// ── OpenAPI ──────────────────────────────────────────────────────────────────

function jsonSchemaFor(endpoint: Endpoint): unknown {
  if (!endpoint.body) return undefined;
  /*
   * `io: 'input'` because these are REQUEST schemas: the client sends the input
   * shape, and several fields transform on the way in (NFC normalisation, for
   * one). Without it, a schema containing a transform cannot be represented at
   * all and the generator throws.
   */
  return z.toJSONSchema(endpoint.body, { io: 'input', target: 'draft-2020-12' });
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

function buildOpenApi(): unknown {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const e of ENDPOINTS) {
    const failures = [...(e.failures ?? []), ...(e.permission ? COMMON_FAILURES : [])];

    const responses: Record<string, unknown> = {
      [String(e.successStatus)]: {
        description: e.returns ?? 'Success.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Envelope' },
          },
        },
      },
    };

    // Grouped by status: several codes can share one, and a client branches on
    // `code` rather than on the status alone.
    const byStatus = new Map<number, string[]>();
    for (const f of failures) {
      byStatus.set(f.status, [...(byStatus.get(f.status) ?? []), `\`${f.code}\` — ${f.when}`]);
    }
    for (const [status, lines] of byStatus) {
      responses[String(status)] = {
        description: lines.join('\n\n'),
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      };
    }

    const description = [
      e.description,
      e.permission && e.permission !== 'authenticated'
        ? `**Permission:** \`${e.permission}\``
        : e.permission === 'authenticated'
          ? '**Requires a session.**'
          : '**No authentication.**',
      ...(e.notes ?? []).map((n) => `> ${n}`),
    ]
      .filter(Boolean)
      .join('\n\n');

    const operation: Record<string, unknown> = {
      tags: [e.tag],
      summary: e.summary,
      description,
      operationId: `${e.method.toLowerCase()}${e.path.replace(/[^\w]+/g, '_')}`,
      parameters: [
        ...pathParams(e.path).map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        })),
        ...(e.query ?? []).map((q) => ({
          name: q.name,
          in: 'query',
          required: false,
          description: q.description,
          schema: { type: 'string' },
        })),
      ],
      responses,
    };

    const schema = jsonSchemaFor(e);
    if (schema) {
      operation['requestBody'] = {
        required: true,
        content: { 'application/json': { schema } },
      };
    }
    if (e.permission) operation['security'] = [{ sessionCookie: [] }];

    paths[e.path] = { ...(paths[e.path] ?? {}), [e.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'School Management API',
      version: '0.1.0',
      description: [
        'Multi-tenant school management for Bangladesh.',
        '',
        '**The tenant is chosen by HOST, never by a parameter.** `demo.example.com`',
        'is one school and `other.example.com` is another; no request body or query',
        'string names a tenant, and the server derives it from the session.',
        '',
        '**Branch on `code`, never on `message`.** `code` is stable and never',
        'localised; `message` is localised and never parsed.',
        '',
        'Generated from the Zod schemas the handlers validate with. Do not edit.',
      ].join('\n'),
    },
    servers: [{ url: 'https://{school}.{domain}', variables: { school: { default: 'demo' }, domain: { default: 'localhost:3000' } } }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sm_session',
          description: 'HttpOnly, SameSite=Lax. Set by the login endpoints; never readable from script.',
        },
      },
      schemas: {
        Envelope: {
          type: 'object',
          required: ['data', 'meta'],
          properties: {
            data: { description: 'The payload. Shape varies by endpoint.' },
            meta: {
              type: 'object',
              required: ['requestId'],
              properties: { requestId: { type: 'string', format: 'uuid' } },
            },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', description: 'Stable. Branch on this.' },
                message: { type: 'string', description: 'Localised. Never parse this.' },
                requestId: { type: 'string', format: 'uuid' },
                details: {
                  type: 'array',
                  description: 'Present for VALIDATION_FAILED: one entry per bad field.',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string' },
                      code: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    paths,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function buildMarkdown(): string {
  const out: string[] = [
    '# API',
    '',
    '**Generated — do not edit.** `pnpm docs:api` rebuilds this and',
    '[`openapi.json`](openapi.json) from `src/shared/api/registry.ts`, whose',
    'request shapes are the same Zod schemas the handlers validate with.',
    '',
    '## Before anything else',
    '',
    '**The tenant is chosen by HOST.** `demo.example.com` is one school,',
    '`other.example.com` is another. No request names a tenant — the server',
    'derives it from the session, which is why a client can never reach across',
    'schools even by guessing an id.',
    '',
    '**Branch on `code`, never on `message`.** `code` is stable and never',
    'localised; `message` is localised and never parsed.',
    '',
    '```jsonc',
    '{ "data": { }, "meta": { "requestId": "…" } }',
    '{ "error": { "code": "STUDENT_NOT_FOUND", "message": "…", "requestId": "…" } }',
    '```',
    '',
    '**Authentication is an `HttpOnly` cookie**, `sm_session`, set by the login',
    'endpoints. It is never in a response body and cannot be read from script.',
    '',
    '### Refusals every authenticated endpoint can produce',
    '',
    '| Status | Code | When |',
    '|---|---|---|',
    ...COMMON_FAILURES.map((f) => `| ${f.status} | \`${f.code}\` | ${f.when} |`),
    '',
  ];

  const tags = [...new Set(ENDPOINTS.map((e) => e.tag))];

  out.push('## Endpoints', '');
  for (const tag of tags) {
    out.push(`### ${tag}`, '');
    out.push('| | Endpoint | Permission |', '|---|---|---|');
    for (const e of ENDPOINTS.filter((x) => x.tag === tag)) {
      const perm =
        e.permission === null
          ? '—'
          : e.permission === 'authenticated'
            ? 'session'
            : `\`${e.permission}\``;
      out.push(`| \`${e.method}\` | [\`${e.path}\`](#${anchor(e)}) | ${perm} |`);
    }
    out.push('');
  }

  for (const tag of tags) {
    out.push(`## ${tag}`, '');
    for (const e of ENDPOINTS.filter((x) => x.tag === tag)) {
      out.push(`### \`${e.method} ${e.path}\``, '');
      out.push(`**${e.summary}**`, '');
      if (e.description) out.push(e.description, '');

      out.push(
        e.permission === null
          ? '_No authentication._'
          : e.permission === 'authenticated'
            ? '_Requires a session._'
            : `_Permission: \`${e.permission}\`_`,
        '',
      );

      if (e.query?.length) {
        out.push('**Query**', '', '| Name | Meaning |', '|---|---|');
        for (const q of e.query) out.push(`| \`${q.name}\` | ${q.description} |`);
        out.push('');
      }

      if (e.body) {
        out.push('**Body**', '', '```json', JSON.stringify(jsonSchemaFor(e), null, 2), '```', '');
      }

      out.push(`**${e.successStatus}** — ${e.returns ?? 'Success.'}`, '');

      if (e.failures?.length) {
        out.push('**Refusals**', '', '| Status | Code | When |', '|---|---|---|');
        for (const f of e.failures) out.push(`| ${f.status} | \`${f.code}\` | ${f.when} |`);
        out.push('');
      }

      if (e.notes?.length) {
        for (const n of e.notes) out.push(`> ${n}`, '');
      }
    }
  }

  return out.join('\n') + '\n';
}

const anchor = (e: Endpoint): string =>
  `${e.method.toLowerCase()}-${e.path}`.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

// ── run ──────────────────────────────────────────────────────────────────────

const openapi = JSON.stringify(buildOpenApi(), null, 2) + '\n';
const markdown = buildMarkdown();

const routes = await actualRoutes();
const documented = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));

const undocumented = [...routes].filter((r) => !documented.has(r)).sort();
const phantom = [...documented].filter((d) => !routes.has(d)).sort();

let failed = false;

if (undocumented.length > 0) {
  console.error('\nThese routes exist but are not in the registry:\n');
  for (const r of undocumented) console.error(`  ${r}`);
  console.error('\nAdd them to src/shared/api/registry.ts.');
  failed = true;
}

if (phantom.length > 0) {
  console.error('\nThese are documented but no route exports them:\n');
  for (const p of phantom) console.error(`  ${p}`);
  console.error('\nDocumenting an endpoint that does not exist is worse than not documenting it.');
  failed = true;
}

if (check) {
  for (const [path, expected] of [
    [OPENAPI_PATH, openapi],
    [MARKDOWN_PATH, markdown],
  ] as const) {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current !== expected) {
      console.error(`\n${relative(ROOT, path)} is stale. Run: pnpm docs:api`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`API documentation is current — ${ENDPOINTS.length} endpoints.`);
} else {
  if (failed) process.exit(1);
  await writeFile(OPENAPI_PATH, openapi, 'utf8');
  await writeFile(MARKDOWN_PATH, markdown, 'utf8');
  console.log(`Wrote docs/openapi.json and docs/API.md — ${ENDPOINTS.length} endpoints.`);
}
