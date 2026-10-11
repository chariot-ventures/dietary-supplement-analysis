import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package.json and package-lock.json', () => {
  it('declare the same dependency ranges (a mismatch makes npm ci hang)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const root = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages[''];
    expect(root.dependencies).toEqual(pkg.dependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    expect(root.version).toBe(pkg.version);
  });
});
