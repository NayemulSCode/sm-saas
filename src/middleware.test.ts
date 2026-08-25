import { describe, it, expect } from 'vitest';
import { resolveSurface } from './middleware';

const ROOT = 'sm.example.com';
const ADMIN = 'admin.sm.example.com';

describe('resolveSurface', () => {
  it('routes the platform host to the operator console', () => {
    expect(resolveSurface(ADMIN, ROOT, ADMIN)).toEqual({ kind: 'platform' });
  });

  it('routes the root host to marketing', () => {
    expect(resolveSurface(ROOT, ROOT, ADMIN)).toEqual({ kind: 'marketing' });
    expect(resolveSurface(`www.${ROOT}`, ROOT, ADMIN)).toEqual({ kind: 'marketing' });
  });

  it('routes a subdomain to its tenant', () => {
    expect(resolveSurface(`dhaka-model.${ROOT}`, ROOT, ADMIN)).toEqual({
      kind: 'tenant',
      slug: 'dhaka-model',
    });
  });

  // The platform host is checked FIRST. If it were treated as a tenant slug,
  // a tenant called "admin" could reach operator routes.
  it('never treats the platform host as a tenant named admin', () => {
    expect(resolveSurface(ADMIN, ROOT, ADMIN)).toEqual({ kind: 'platform' });
    expect(resolveSurface(ADMIN, ROOT, ADMIN).kind).not.toBe('tenant');
  });

  // Custom domains are Phase 2. Until then an unknown host must NOT be
  // silently treated as a tenant.
  it('rejects an unknown host rather than guessing', () => {
    expect(resolveSurface('some-school.com', ROOT, ADMIN)).toEqual({ kind: 'unknown' });
    expect(resolveSurface('evil.example.org', ROOT, ADMIN)).toEqual({ kind: 'unknown' });
  });

  it('rejects a nested subdomain as a tenant', () => {
    expect(resolveSurface(`a.b.${ROOT}`, ROOT, ADMIN)).toEqual({ kind: 'unknown' });
  });

  // A host that merely ENDS WITH the root string is not under it.
  it('does not match a look-alike suffix domain', () => {
    expect(resolveSurface('evilsm.example.com', ROOT, ADMIN)).toEqual({ kind: 'unknown' });
    expect(resolveSurface('notsm.example.com', ROOT, ADMIN)).toEqual({ kind: 'unknown' });
  });

  it('handles localhost development hosts', () => {
    expect(resolveSurface('localhost', 'localhost', 'admin.localhost')).toEqual({
      kind: 'marketing',
    });
    expect(resolveSurface('dhaka.localhost', 'localhost', 'admin.localhost')).toEqual({
      kind: 'tenant',
      slug: 'dhaka',
    });
    expect(resolveSurface('admin.localhost', 'localhost', 'admin.localhost')).toEqual({
      kind: 'platform',
    });
  });
});
