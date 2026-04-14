import { describe, it, expect } from 'vitest';
import { parseConnectionString } from '../src/database/backup';

describe('parseConnectionString', () => {
  it('parses standard postgres URL', () => {
    const r = parseConnectionString('postgresql://user:pass@localhost:5432/mydb');
    expect(r.host).toBe('localhost');
    expect(r.port).toBe('5432');
    expect(r.user).toBe('user');
    expect(r.password).toBe('pass');
    expect(r.database).toBe('mydb');
  });
  it('parses neon URL', () => {
    const r = parseConnectionString('postgresql://admin:3p%40rd!@ep-abc.us-east-2.aws.neon.tech:5432/neondb?sslmode=require');
    expect(r.host).toBe('ep-abc.us-east-2.aws.neon.tech');
    expect(r.port).toBe('5432');
    expect(r.user).toBe('admin');
    expect(r.password).toBe('3p@rd!');
    expect(r.database).toBe('neondb');
  });
  it('handles URL without port', () => {
    const r = parseConnectionString('postgresql://user@host/dbasename');
    expect(r.host).toBe('host');
    expect(r.port).toBeUndefined();
    expect(r.user).toBe('user');
    expect(r.database).toBe('dbasename');
  });
  it('returns empty object for invalid URL', () => {
    expect(parseConnectionString('not-a-url')).toEqual({});
  });
  it('returns empty object for empty string', () => {
    expect(parseConnectionString('')).toEqual({});
  });
  it('handles special characters in password', () => {
    const r = parseConnectionString('postgresql://user:p@ss:w0rd@host/db');
    expect(r.password).toBe('p@ss:w0rd');
  });
  it('handles URL with encoded username', () => {
    const r = parseConnectionString('postgresql://my%20user:pass@host/db');
    expect(r.user).toBe('my user');
  });
});
